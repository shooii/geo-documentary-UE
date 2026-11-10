#include "GeoMap.h"
#include "GeoSky.h"
#include "Engine/PostProcessVolume.h"
#include "Engine/Scene.h"
#include "Camera/CameraComponent.h"
#include "CanvasItem.h"
#include "Engine/Canvas.h"
#include "Engine/Engine.h"
#include "Engine/Font.h"
#include "Engine/GameViewportClient.h"
#include "Engine/Texture2D.h"
#include "HAL/IConsoleManager.h"
#include "HAL/PlatformFileManager.h"
#include "HAL/PlatformMisc.h"
#include "HttpModule.h"
#include "IImageWrapper.h"
#include "IImageWrapperModule.h"
#include "ImageUtils.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Kismet/GameplayStatics.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "ProceduralMeshComponent.h"
#include "Serialization/JsonSerializer.h"
#include "Slate/SceneViewport.h"
#include "UObject/UnrealType.h"
#include "UnrealClient.h"
#include <cmath>
IMPLEMENT_PRIMARY_GAME_MODULE(FDefaultGameModuleImpl, GeoDocumentary, "GeoDocumentary");

static double N(const TSharedPtr<FJsonObject> &J, const TCHAR *Key, double Default = 0)
{
    double V;
    return J.IsValid() && J->TryGetNumberField(Key, V) ? V : Default;
}
static FString S(const TSharedPtr<FJsonObject> &J, const TCHAR *Key)
{
    FString V;
    if (J.IsValid())
        J->TryGetStringField(Key, V);
    return V;
}
static TSharedPtr<FJsonObject> O(const TSharedPtr<FJsonObject> &J, const TCHAR *Key)
{
    const TSharedPtr<FJsonObject> *V;
    return J.IsValid() && J->TryGetObjectField(Key, V) ? *V : MakeShared<FJsonObject>();
}
static UTexture2D *LoadCloudTexture(const FString &File)
{
    TArray<uint8> Bytes;
    if (!FFileHelper::LoadFileToArray(Bytes, *File))
        return nullptr;
    auto &Module = FModuleManager::LoadModuleChecked<IImageWrapperModule>(TEXT("ImageWrapper"));
    auto Wrapper = Module.CreateImageWrapper(EImageFormat::PNG);
    TArray64<uint8> Pixels;
    if (!Wrapper->SetCompressed(Bytes.GetData(), Bytes.Num()) || !Wrapper->GetRaw(ERGBFormat::BGRA, 8, Pixels))
        return nullptr;
    auto *Texture = UTexture2D::CreateTransient(Wrapper->GetWidth(), Wrapper->GetHeight(), PF_B8G8R8A8);
    void *Data = Texture->GetPlatformData()->Mips[0].BulkData.Lock(LOCK_READ_WRITE);
    FMemory::Memcpy(Data, Pixels.GetData(), Pixels.Num());
    Texture->GetPlatformData()->Mips[0].BulkData.Unlock();
    Texture->SRGB = true;
    Texture->UpdateResource();
    return Texture;
}
static FVector Ecef(double Lon, double Lat, double H)
{
    const double L = FMath::DegreesToRadians(Lon), P = FMath::DegreesToRadians(Lat), A = 6378137.0,
                 E = 0.00669437999014;
    double R = A / FMath::Sqrt(1 - E * FMath::Square(FMath::Sin(P)));
    return FVector((R + H) * FMath::Cos(P) * FMath::Cos(L), (R + H) * FMath::Cos(P) * FMath::Sin(L),
                   (R * (1 - E) + H) * FMath::Sin(P));
}
FVector AGeoMap::Geo(double Lon, double Lat, double H) const
{
    FVector D = Ecef(Lon, Lat, H) - Ecef(OriginLon, OriginLat, 0);
    double L = FMath::DegreesToRadians(OriginLon), P = FMath::DegreesToRadians(OriginLat);
    return FVector(FVector::DotProduct(
                       D, FVector(-FMath::Sin(P) * FMath::Cos(L), -FMath::Sin(P) * FMath::Sin(L), FMath::Cos(P))),
                   FVector::DotProduct(D, FVector(-FMath::Sin(L), FMath::Cos(L), 0)),
                   FVector::DotProduct(
                       D, FVector(FMath::Cos(P) * FMath::Cos(L), FMath::Cos(P) * FMath::Sin(L), FMath::Sin(P)))) *
           100;
}
AGeoMap::AGeoMap()
{
    PrimaryActorTick.bCanEverTick = true;
    RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
    Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
    Camera->SetupAttachment(RootComponent);
    Camera->FieldOfView = 60;
    Camera->bConstrainAspectRatio = false;
    Camera->bOverrideAspectRatioAxisConstraint = true;
    Camera->SetAspectRatioAxisConstraint(EAspectRatioAxisConstraint::AspectRatio_MaintainXFOV);
}
void AGeoMap::BeginPlay()
{
    Super::BeginPlay();
    GAreScreenMessagesEnabled = false;
    // 30 fps reads as judder on a 60 Hz display when the camera is dollying over the map,
    // so the preview cap is tunable: GEO_STREAM_FPS=60 halves the frame budget and only
    // pays off while the renderer actually holds it. The default stays at the rate the
    // volumetric shots were tuned against.
    int32 StreamFps = 30;
    {
        const FString Requested = FPlatformMisc::GetEnvironmentVariable(TEXT("GEO_STREAM_FPS"));
        if (!Requested.IsEmpty())
            StreamFps = FMath::Clamp(FCString::Atoi(*Requested), 15, 120);
    }
    UE_LOG(LogTemp, Display, TEXT("GEO_STREAM_FPS %d"), StreamFps);
    if (auto *Limit = IConsoleManager::Get().FindConsoleVariable(TEXT("t.MaxFPS")))
        Limit->Set(float(StreamFps), ECVF_SetByCode);
    if (auto *Rate = IConsoleManager::Get().FindConsoleVariable(TEXT("PixelStreaming2.WebRTC.Fps")))
        Rate->Set(StreamFps, ECVF_SetByCode);
    FParse::Value(FCommandLine::Get(), TEXT("GeoCaptureRoot="), CaptureRoot);
    TileMaterial = LoadObject<UMaterialInterface>(nullptr, TEXT("/Game/Geo/M_Tile.M_Tile"));
    // Native UE5 sky: SkyAtmosphere + VolumetricCloud (1.5-3.5 km) + sun. The old
    // canvas cloud overlay stands down as soon as this actor exists.
    // GEO_NO_SKY=1 keeps the pre-sky render path for A/B diagnosis.
    const bool bNoSky = FPlatformMisc::GetEnvironmentVariable(TEXT("GEO_NO_SKY")).Len() > 0;
    if (!bNoSky)
    {
        Sky = GetWorld()->SpawnActor<AGeoVolumetricSky>(AGeoVolumetricSky::StaticClass(), FTransform::Identity);
        if (auto *Volume = GetWorld()->SpawnActor<APostProcessVolume>())
        {
            Volume->bUnbound = true;
            Volume->BlendWeight = 1.f;
            Volume->Priority = 10.f;
            // Do not switch the exposure method here: AEM_Manual pulls the whole map
            // about 2.5 stops down and the tiles are unlit, so nothing adapts back.
            // The shot-driven bias below is enough for the through-cloud beat.
            Volume->Settings.bOverride_AutoExposureBias = true;
            Volume->Settings.AutoExposureBias = 0.f;
            Volume->Settings.bOverride_BloomIntensity = true;
            Volume->Settings.BloomIntensity = 1.f;
            Volume->Settings.bOverride_BloomThreshold = true;
            Volume->Settings.BloomThreshold = 1.1f;
            PostProcess = Volume;
        }
    }
    InitBoundaryEffects();
    CloudDeck = LoadCloudTexture(FPaths::Combine(FPaths::ProjectContentDir(), TEXT("Geo/cloud-deck.png")));
    CloudPass = LoadCloudTexture(FPaths::Combine(FPaths::ProjectContentDir(), TEXT("Geo/cloud-pass.png")));
    UClass *C = LoadClass<UActorComponent>(nullptr, TEXT("/Script/PixelStreaming2.PixelStreaming2Input"));
    if (C)
    {
        Input = NewObject<UActorComponent>(this, C);
        AddInstanceComponent(Input);
        Input->RegisterComponent();
        if (!Input->HasBegunPlay())
            Input->BeginPlay();
        auto *P = FindFProperty<FMulticastDelegateProperty>(C, TEXT("OnInputEvent"));
        if (P)
        {
            FScriptDelegate D;
            D.BindUFunction(this, TEXT("OnInput"));
            P->AddDelegate(D, Input);
        }
    }
    if (auto *PC = GetWorld()->GetFirstPlayerController())
    {
        PC->SetViewTarget(this);
        PC->bShowMouseCursor = true;
    }
}
void AGeoMap::Respond(FString Id, FString Error)
{
    if (!Input)
        return;
    UpdateTileCounts();
    auto J = MakeShared<FJsonObject>();
    J->SetStringField(TEXT("type"), TEXT("geo-video-ue"));
    J->SetStringField(TEXT("requestId"), Id);
    if (!Error.IsEmpty())
        J->SetStringField(TEXT("error"), Error);
    J->SetNumberField(TEXT("pendingTiles"), PendingTiles);
    J->SetNumberField(TEXT("failedTiles"), FailedTiles);
    J->SetNumberField(TEXT("wantedDetailTiles"), RequiredTiles.Num());
    J->SetNumberField(TEXT("visibleDetailTiles"), RequiredTiles.Num() - PendingTiles - FailedTiles);
    J->SetStringField(TEXT("imagery"), ImageryProvider);
    J->SetNumberField(TEXT("loadedTiles"), Resources.Num() / 3);
    J->SetNumberField(TEXT("frameMs"), AverageFrameMs);
    J->SetNumberField(TEXT("fps"), AverageFrameMs > 0 ? 1000 / AverageFrameMs : 0);
    J->SetNumberField(TEXT("boundaryLiftMeters"), BoundaryLift / 100);
    J->SetNumberField(TEXT("boundarySparkCount"), HasRaisedBoundary() ? BoundarySparks.Num() : 0);
    J->SetNumberField(TEXT("boundaryVertices"), BoundaryVertices);
    int32 Width = 0, Height = 0;
    if (auto *PC = GetWorld()->GetFirstPlayerController())
        PC->GetViewportSize(Width, Height);
    J->SetNumberField(TEXT("width"), Width);
    J->SetNumberField(TEXT("height"), Height);
    J->SetNumberField(TEXT("fov"), Camera->FieldOfView);
    J->SetStringField(TEXT("profile"), RenderProfile);
    J->SetNumberField(TEXT("filledRegions"), Fills.Num());
    FVector2D Minimum(DBL_MAX, DBL_MAX), Maximum(-DBL_MAX, -DBL_MAX);
    if (auto *PC = GetWorld()->GetFirstPlayerController())
        for (const auto &Ring : Rings)
            if (Ring.Parent)
                for (const auto &Point : Ring.Points)
                {
                    FVector2D Pixel;
                    if (PC->ProjectWorldLocationToScreen(Point, Pixel))
                    {
                        Minimum.X = FMath::Min(Minimum.X, Pixel.X);
                        Minimum.Y = FMath::Min(Minimum.Y, Pixel.Y);
                        Maximum.X = FMath::Max(Maximum.X, Pixel.X);
                        Maximum.Y = FMath::Max(Maximum.Y, Pixel.Y);
                    }
                }
    if (Width > 0 && Height > 0 && Minimum.X != DBL_MAX)
    {
        auto Bounds = MakeShared<FJsonObject>();
        Bounds->SetNumberField(TEXT("left"), Minimum.X / Width);
        Bounds->SetNumberField(TEXT("right"), Maximum.X / Width);
        Bounds->SetNumberField(TEXT("top"), Minimum.Y / Height);
        Bounds->SetNumberField(TEXT("bottom"), Maximum.Y / Height);
        J->SetObjectField(TEXT("parentScreenBounds"), Bounds);
    }
    FString Out;
    FJsonSerializer::Serialize(J, TJsonWriterFactory<>::Create(&Out));
    if (UFunction *F = Input->FindFunction(TEXT("SendPixelStreaming2Response")))
    {
        struct
        {
            FString Descriptor;
        } Params{Out};
        Input->ProcessEvent(F, &Params);
    }
}
void AGeoMap::OnInput(const FString &Descriptor)
{
    TSharedPtr<FJsonObject> J;
    if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Descriptor), J) || !J.IsValid() ||
        S(J, TEXT("type")) != TEXT("geo-video-ue"))
        return;
    FString Action = S(J, TEXT("action")), Id = S(J, TEXT("requestId"));
    if (Action != TEXT("apply-frame"))
        UE_LOG(LogTemp, Display, TEXT("GEO_COMMAND %s"), *Action);
    if (Action == TEXT("load-scene"))
    {
        LoadScene(J, Id);
        return;
    }
    if (Action == TEXT("set-imagery"))
    {
        SetImagery(J, Id);
        return;
    }
    if (Action == TEXT("get-status"))
    {
        Respond(Id);
        return;
    }
    if (Action == TEXT("apply-frame"))
    {
        ApplyFrame(O(J, TEXT("frame")));
        return;
    }
    if (Action == TEXT("capture-frame"))
    {
        if (CaptureRoot.IsEmpty())
        {
            Respond(Id, TEXT("Launch with -GeoCaptureRoot for offline frame capture"));
            return;
        }
        if (!CaptureId.IsEmpty())
        {
            Respond(Id, TEXT("Capture already in progress"));
            return;
        }
        ApplyFrame(O(J, TEXT("frame")));
        CaptureId = Id;
        CaptureTicks = 0;
        CaptureStarted = FPlatformTime::Seconds();
        return;
    }
    if (Action == TEXT("set-annotations"))
    {
        const TArray<TSharedPtr<FJsonValue>> *Windows;
        if (J->TryGetArrayField(TEXT("annotationWindows"), Windows) && Windows->Num() > 0)
        {
            Respond(Id, TEXT("Native imagery annotation layers are pending"));
        }
        else
            Respond(Id);
        return;
    }
    if (Action == TEXT("update-tour-labels"))
    {
        const TArray<TSharedPtr<FJsonValue>> *V;
        if (J->TryGetArrayField(TEXT("labels"), V))
            for (auto &X : *V)
                for (auto &Label : Labels)
                    if (Label.Id == S(X->AsObject(), TEXT("id")))
                        Label.Name = S(X->AsObject(), TEXT("name"));
        Respond(Id);
        return;
    }
    Respond(Id, TEXT("Unsupported native command"));
}
void AGeoMap::LoadScene(const TSharedPtr<FJsonObject> &Data, FString Id)
{
    if (CaptureRoot.IsEmpty())
    {
        const int32 Width = FMath::Clamp(int32(N(Data, TEXT("width"), 720)), 320, 1920);
        const int32 Height = FMath::Clamp(int32(N(Data, TEXT("height"), 1280)), 320, 1920);
        RequestedSize = FIntPoint(Width, Height);
        if (GEngine && GEngine->GameViewport && GEngine->GameViewport->GetGameViewport())
        {
            GEngine->GameViewport->GetGameViewport()->SetFixedViewportSize(Width, Height);
            GEngine->GameViewport->GetGameViewport()->SetViewportSize(Width, Height);
        }
    }
    RenderProfile = S(Data, TEXT("profile"));
    const FString Url = S(Data, TEXT("url"));
    if (!Url.StartsWith(TEXT("http://127.0.0.1:")))
    {
        Respond(Id, TEXT("Only loopback scene sources are allowed"));
        return;
    }
    const int32 G = ++SceneRequest;
    auto R = FHttpModule::Get().CreateRequest();
    R->SetURL(Url);
    R->SetVerb(TEXT("GET"));
    R->OnProcessRequestComplete().BindWeakLambda(this, [this, Id, G](FHttpRequestPtr, FHttpResponsePtr Response,
                                                                     bool Ok) {
        if (G != SceneRequest)
            return;
        if (!Ok || !Response || Response->GetResponseCode() != 200)
        {
            Respond(Id, TEXT("Scene download failed"));
            return;
        }
        TSharedPtr<FJsonObject> Scene;
        if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Response->GetContentAsString()), Scene))
        {
            Respond(Id, TEXT("Invalid scene JSON"));
            return;
        }
        if (!TileMaterial)
        {
            Respond(Id, TEXT("Missing /Game/Geo/M_Tile: run prepare_content.py first"));
            return;
        }
        const auto Imagery = O(Scene, TEXT("imagery"));
        const FString Template = S(Imagery, TEXT("tileTemplate"));
        if (!Template.StartsWith(TEXT("http://127.0.0.1:")))
        {
            Respond(Id, TEXT("Invalid local imagery service configuration"));
            return;
        }
        TileTemplate = Template;
        ImageryProvider = S(Imagery, TEXT("provider"));
        ImageryAttribution = S(Imagery, TEXT("attribution"));
        ++Generation;
        for (const auto &Entry : ActiveTiles)
        {
            Entry.Value->OnProcessRequestComplete().Unbind();
            Entry.Value->CancelRequest();
        }
        ActiveTiles.Reset();
        TileMeshes.Reset();
        TileCacheOrder.Reset();
        TileQueue.Reset();
        TileAttempts.Reset();
        TileFailures.Reset();
        VisibleTiles.Reset();
        RequiredTiles.Reset();
        ShownTiles.Reset();
        TileImages.Reset();
        Frame.Reset();
        UpdateBoundaryEffects(TEXT(""), TArray<FString>(), 0, 0, 0);
        BoundaryGeneration = -1;
        for (auto &X : Resources)
            if (auto *C = Cast<UProceduralMeshComponent>(X))
                C->DestroyComponent();
        Resources.Empty();
        Rings.Empty();
        Fills.Empty();
        BoundaryVertices = 0;
        Labels.Empty();
        ContextRings.Empty();
        ContextFills.Empty();
        ContextBounds = FBox(ForceInit);
        ContextOrigin = FVector::ZeroVector;
        ContextReachMeters = 0;
        HasContext = false;
        TileCenter.Z = -1;
        PendingTiles = FailedTiles = 0;
        const auto Region = O(Scene, TEXT("region"));
        const TArray<TSharedPtr<FJsonValue>> *Center;
        if (Region->TryGetArrayField(TEXT("center"), Center) && Center->Num() >= 2)
        {
            OriginLon = (*Center)[0]->AsNumber();
            OriginLat = (*Center)[1]->AsNumber();
        }
        const TArray<TSharedPtr<FJsonValue>> *LabelPoint;
        if (Region->TryGetArrayField(TEXT("labelPoint"), LabelPoint) && LabelPoint->Num() >= 2)
        {
            // The tracking between the characters is the HUD's job now: it draws the town
            // name one character at a time so it controls the exact advance, can fit the
            // name inside the boundary and can float the characters. Baking spaces into
            // the string here made all three impossible.
            Labels.Add({Geo((*LabelPoint)[0]->AsNumber(), (*LabelPoint)[1]->AsNumber(), 10), S(Region, TEXT("id")),
                        S(Region, TEXT("name")), true, S(Region, TEXT("labelPlate"))});
        }
        const TArray<TSharedPtr<FJsonValue>> *Layers;
        if (Scene->TryGetArrayField(TEXT("layers"), Layers))
            for (auto &V : *Layers)
            {
                auto F = V->AsObject();
                bool Parent = false;
                F->TryGetBoolField(TEXT("parent"), Parent);
                auto Props = O(F, TEXT("properties"));
                auto Geometry = O(F, TEXT("geometry"));
                const TArray<TSharedPtr<FJsonValue>> *Coords;
                if (!Geometry->TryGetArrayField(TEXT("coordinates"), Coords))
                    continue;
                TArray<TSharedPtr<FJsonValue>> Polys =
                    S(Geometry, TEXT("type")) == TEXT("Polygon")
                        ? TArray<TSharedPtr<FJsonValue>>{MakeShared<FJsonValueArray>(*Coords)}
                        : *Coords;
                for (auto &Poly : Polys)
                    for (auto &Ring : Poly->AsArray())
                    {
                        FGeoRing Out;
                        Out.Parent = Parent;
                        Out.Id = S(Props, TEXT("id"));
                        if (Out.Id.IsEmpty())
                            Out.Id = S(Props, TEXT("adcode"));
                        for (auto &Point : Ring->AsArray())
                        {
                            auto &P = Point->AsArray();
                            if (P.Num() >= 2)
                            {
                                const FVector Position = Geo(P[0]->AsNumber(), P[1]->AsNumber(), 5);
                                if (Out.Points.IsEmpty() || !Out.Points.Last().Equals(Position))
                                    Out.Points.Add(Position);
                            }
                        }
                        if (Out.Points.Num() >= 3 && !Out.Points[0].Equals(Out.Points.Last()))
                            Out.Points.Add(Out.Points[0]);
                        Out.Lengths.Add(0);
                        for (int32 I = 1; I < Out.Points.Num(); I++)
                            Out.Lengths.Add(Out.Lengths.Last() + FVector::Distance(Out.Points[I - 1], Out.Points[I]));
                        BoundaryVertices += Out.Points.Num();
                        Rings.Add(MoveTemp(Out));
                    }
                const TArray<TSharedPtr<FJsonValue>> *Triangulations;
                if (F->TryGetArrayField(TEXT("triangulations"), Triangulations))
                    for (const auto &Tri : *Triangulations)
                    {
                        const auto Data = Tri->AsObject();
                        const auto &Vertices = Data->GetArrayField(TEXT("vertices"));
                        const auto &Indices = Data->GetArrayField(TEXT("indices"));
                        FGeoFill Fill;
                        Fill.Parent = Parent;
                        Fill.Id = S(Props, TEXT("id"));
                        if (Fill.Id.IsEmpty())
                            Fill.Id = S(Props, TEXT("adcode"));
                        const int32 Dimensions = int32(N(Data, TEXT("dimensions"), 2));
                        for (int32 I = 0; I + 1 < Vertices.Num(); I += Dimensions)
                            Fill.Vertices.Add(Geo(Vertices[I]->AsNumber(), Vertices[I + 1]->AsNumber(), 5));
                        for (const auto &Index : Indices)
                            Fill.Indices.Add(int32(Index->AsNumber()));
                        Fills.Add(MoveTemp(Fill));
                    }
                const TArray<TSharedPtr<FJsonValue>> *P;
                if (!Parent && Props->TryGetArrayField(TEXT("labelPoint"), P) && P->Num() >= 2)
                {
                    FString LabelId = S(Props, TEXT("id"));
                    if (LabelId.IsEmpty())
                        LabelId = S(Props, TEXT("adcode"));
                    Labels.Add({Geo((*P)[0]->AsNumber(), (*P)[1]->AsNumber(), 10), LabelId, S(Props, TEXT("name")), false,
                                S(Props, TEXT("labelPlate"))});
                }
            }
        const auto Context = O(Scene, TEXT("context"));
        const TArray<TSharedPtr<FJsonValue>> *ContextLayers;
        if (Context->TryGetArrayField(TEXT("layers"), ContextLayers))
            for (auto &V : *ContextLayers)
            {
                auto F = V->AsObject();
                auto Geometry = O(F, TEXT("geometry"));
                const TArray<TSharedPtr<FJsonValue>> *Coords;
                if (!Geometry->TryGetArrayField(TEXT("coordinates"), Coords))
                    continue;
                TArray<TSharedPtr<FJsonValue>> Polys =
                    S(Geometry, TEXT("type")) == TEXT("Polygon")
                        ? TArray<TSharedPtr<FJsonValue>>{MakeShared<FJsonValueArray>(*Coords)}
                        : *Coords;
                for (auto &Poly : Polys)
                    for (auto &Ring : Poly->AsArray())
                    {
                        FGeoRing Out;
                        Out.Parent = true;
                        for (auto &Point : Ring->AsArray())
                        {
                            auto &P = Point->AsArray();
                            if (P.Num() >= 2)
                            {
                                const FVector Position = Geo(P[0]->AsNumber(), P[1]->AsNumber(), 5);
                                if (Out.Points.IsEmpty() || !Out.Points.Last().Equals(Position))
                                    Out.Points.Add(Position);
                            }
                        }
                        if (Out.Points.Num() >= 3 && !Out.Points[0].Equals(Out.Points.Last()))
                            Out.Points.Add(Out.Points[0]);
                        Out.Lengths.Add(0);
                        for (int32 I = 1; I < Out.Points.Num(); I++)
                            Out.Lengths.Add(Out.Lengths.Last() + FVector::Distance(Out.Points[I - 1], Out.Points[I]));
                        for (const FVector &Point : Out.Points)
                            ContextBounds += Point;
                        BoundaryVertices += Out.Points.Num();
                        ContextRings.Add(MoveTemp(Out));
                    }
                const TArray<TSharedPtr<FJsonValue>> *Triangulations;
                if (F->TryGetArrayField(TEXT("triangulations"), Triangulations))
                    for (const auto &Tri : *Triangulations)
                    {
                        const auto Data = Tri->AsObject();
                        const auto &Vertices = Data->GetArrayField(TEXT("vertices"));
                        const auto &Indices = Data->GetArrayField(TEXT("indices"));
                        FGeoFill Fill;
                        Fill.Parent = true;
                        const int32 Dimensions = int32(N(Data, TEXT("dimensions"), 2));
                        for (int32 I = 0; I + 1 < Vertices.Num(); I += Dimensions)
                            Fill.Vertices.Add(Geo(Vertices[I]->AsNumber(), Vertices[I + 1]->AsNumber(), 5));
                        for (const auto &Index : Indices)
                            Fill.Indices.Add(int32(Index->AsNumber()));
                        ContextFills.Add(MoveTemp(Fill));
                    }
            }
        const TArray<TSharedPtr<FJsonValue>> *ContextLabelPoint;
        if (Context->TryGetArrayField(TEXT("labelPoint"), ContextLabelPoint) && ContextLabelPoint->Num() >= 2)
        {
            ContextLabel.Position = Geo((*ContextLabelPoint)[0]->AsNumber(), (*ContextLabelPoint)[1]->AsNumber(), 10);
            ContextLabel.Id = S(Context, TEXT("id"));
            ContextLabel.Name = S(Context, TEXT("name"));
            ContextLabel.Parent = true;
        }
        HasContext = ContextRings.Num() > 0 && ContextBounds.IsValid;
        if (HasContext)
        {
            // The county fills outward from the town the same way water would, so the
            // front is a real distance rather than a timeline or arc-length ratio.
            ContextOrigin = Geo(OriginLon, OriginLat, 5);
            const FVector BoundsCenter = ContextBounds.GetCenter();
            double Reach = 0;
            for (int32 Corner = 0; Corner < 4; Corner++)
            {
                const FVector CornerPoint((Corner & 1) ? ContextBounds.Max.X : ContextBounds.Min.X,
                                          (Corner & 2) ? ContextBounds.Max.Y : ContextBounds.Min.Y, BoundsCenter.Z);
                Reach = FMath::Max(Reach, FVector::Dist2D(ContextOrigin, CornerPoint));
            }
            ContextReachMeters = FMath::Max(1000.0, Reach / 100.0);
        }
        Respond(Id);
    });
    R->ProcessRequest();
}
void AGeoMap::SetImagery(const TSharedPtr<FJsonObject> &Data, FString Id)
{
    auto Imagery = O(Data, TEXT("imagery"));
    FString Template = S(Imagery, TEXT("tileTemplate"));
    if (Template.IsEmpty())
    {
        // Also accept the descriptor as the whole payload, so a caller does not have
        // to know whether it should be wrapped or not.
        Imagery = Data;
        Template = S(Imagery, TEXT("tileTemplate"));
    }
    if (!Template.StartsWith(TEXT("http://127.0.0.1:")))
    {
        Respond(Id, TEXT("Invalid local imagery service configuration"));
        return;
    }
    // Swapping the basemap is a tile-layer operation only. Everything that makes the
    // scene the scene — rings, fills, labels, the boundary block and the camera — is
    // deliberately left untouched, so the pixel stream keeps its session and the
    // picture simply resolves into the new imagery as fresh tiles arrive.
    TileTemplate = Template;
    ImageryProvider = S(Imagery, TEXT("provider"));
    ImageryAttribution = S(Imagery, TEXT("attribution"));
    ++Generation;
    for (const auto &Entry : ActiveTiles)
    {
        Entry.Value->OnProcessRequestComplete().Unbind();
        Entry.Value->CancelRequest();
    }
    ActiveTiles.Reset();
    // Drop the old tiles one by one instead of clearing `Resources`: that array also
    // owns the boundary meshes, and emptying it would take the 3D relief with it.
    for (const auto &Entry : TileMeshes)
    {
        auto *Mesh = Entry.Value.Get();
        if (!IsValid(Mesh))
            continue;
        auto *Material = Cast<UMaterialInstanceDynamic>(Mesh->GetMaterial(0));
        UTexture *Texture = nullptr;
        if (Material)
            Material->GetTextureParameterValue(FMaterialParameterInfo(TEXT("Imagery")), Texture);
        Resources.Remove(Texture);
        Resources.Remove(Material);
        Resources.Remove(Mesh);
        Mesh->DestroyComponent();
    }
    TileMeshes.Reset();
    TileCacheOrder.Reset();
    TileQueue.Reset();
    TileAttempts.Reset();
    TileFailures.Reset();
    VisibleTiles.Reset();
    RequiredTiles.Reset();
    ShownTiles.Reset();
    TileImages.Reset();
    // RefreshTiles short-circuits when the tile window did not move, so the centre
    // has to be invalidated explicitly or the new provider would never be fetched.
    TileCenter = FIntVector(0, 0, -1);
    PendingTiles = FailedTiles = 0;
    UE_LOG(LogTemp, Display, TEXT("GEO_IMAGERY %s %s"), *ImageryProvider, *Template);
    Respond(Id);
}
void AGeoMap::TileFailed(const FIntVector &Key)
{
    if (!VisibleTiles.Contains(Key))
        return;
    if (TileAttempts.FindRef(Key) < 2)
        TileQueue.Insert({Key, DBL_MAX}, 0);
    else
        TileFailures.Add(Key);
}

void AGeoMap::StartTile(const FIntVector &Key)
{
    const int32 X = Key.X, Y = Key.Y, Z = Key.Z, Size = 1 << Z, G = Generation;
    auto Request = FHttpModule::Get().CreateRequest();
    FString Url = TileTemplate;
    Url.ReplaceInline(TEXT("{z}"), *FString::FromInt(Z));
    Url.ReplaceInline(TEXT("{x}"), *FString::FromInt(X));
    Url.ReplaceInline(TEXT("{y}"), *FString::FromInt(Y));
    Request->SetURL(Url);
    Request->SetTimeout(8.f);
    ++TileAttempts.FindOrAdd(Key);
    ActiveTiles.Add(Key, Request);
    Request->OnProcessRequestComplete().BindWeakLambda(
        this, [this, G, Key](FHttpRequestPtr, FHttpResponsePtr Response, bool Ok) {
            if (G != Generation || !ActiveTiles.Remove(Key) || !VisibleTiles.Contains(Key))
                return;
            if (!Ok || !Response || Response->GetResponseCode() != 200)
            {
                TileFailed(Key);
                return;
            }
            auto &M = FModuleManager::LoadModuleChecked<IImageWrapperModule>(TEXT("ImageWrapper"));
            auto Type = M.DetectImageFormat(Response->GetContent().GetData(), Response->GetContentLength());
            if (Type == EImageFormat::Invalid)
            {
                TileFailed(Key);
                return;
            }
            auto W = M.CreateImageWrapper(Type);
            TArray64<uint8> Pixels;
            if (!W.IsValid() || !W->SetCompressed(Response->GetContent().GetData(), Response->GetContentLength()) ||
                !W->GetRaw(ERGBFormat::BGRA, 8, Pixels))
            {
                TileFailed(Key);
                return;
            }
            TileAttempts.Remove(Key);
            TileImages.Add({Key, int32(W->GetWidth()), int32(W->GetHeight()), Generation, MoveTemp(Pixels)});
        });
    if (!Request->ProcessRequest() && ActiveTiles.Remove(Key))
        TileFailed(Key);
}

/**
 * The upload half of StartTile. Kept on the tick so a flight that lands thirty tiles in
 * one frame spreads them over several frames instead of stalling on thirty texture
 * creations at once — that stall is what made a moving shot drop to ~18 fps.
 */
void AGeoMap::CommitTile(FGeoTileImage &&Image)
{
    if (!TileMaterial || Image.Width <= 0 || Image.Height <= 0)
        return;
    const FIntVector Key = Image.Key;
    auto *Texture = UTexture2D::CreateTransient(Image.Width, Image.Height, PF_B8G8R8A8);
    void *Ptr = Texture->GetPlatformData()->Mips[0].BulkData.Lock(LOCK_READ_WRITE);
    FMemory::Memcpy(Ptr, Image.Pixels.GetData(), Image.Pixels.Num());
    Texture->GetPlatformData()->Mips[0].BulkData.Unlock();
    Texture->SRGB = true;
    Texture->UpdateResource();
    auto *Material = UMaterialInstanceDynamic::Create(TileMaterial, this);
    Material->SetTextureParameterValue(TEXT("Imagery"), Texture);
    auto *Mesh = NewObject<UProceduralMeshComponent>(this);
    Mesh->SetupAttachment(RootComponent);
    Mesh->RegisterComponent();
    TArray<FVector> Vertices;
    TArray<int32> Indices;
    TArray<FVector2D> UV;
    const int32 X = Key.X, Y = Key.Y, Z = Key.Z, Size = 1 << Z;
    // Power-of-two subdivisions align the parent and child surfaces.
    // Otherwise their triangles can intersect during the LOD handoff.
    const int32 Steps = FMath::Max(4, 128 >> Z);
    for (int32 J = 0; J <= Steps; J++)
        for (int32 I = 0; I <= Steps; I++)
        {
            double U = double(I) / Steps, V = double(J) / Steps, Lon = (X + U) / Size * 360 - 180,
                   Lat = FMath::RadiansToDegrees(FMath::Atan(FMath::Sinh(PI * (1 - 2 * (Y + V) / Size))));
            Vertices.Add(Geo(Lon, Lat, Z == 2 ? 0.0 : 2.0 + Z * .2));
            UV.Add(FVector2D(U, V));
        }
    for (int32 J = 0; J < Steps; J++)
        for (int32 I = 0; I < Steps; I++)
        {
            int32 A = J * (Steps + 1) + I, B = A + 1, C = A + Steps + 1, D = C + 1;
            Indices.Append({A, C, B, B, C, D});
        }
    Mesh->CreateMeshSection(0, Vertices, Indices, TArray<FVector>(), UV, TArray<FColor>(),
                            TArray<FProcMeshTangent>(), false);
    Mesh->SetMaterial(0, Material);
    Mesh->SetCastShadow(false);
    Resources.Append({Texture, Material, Mesh});
    TileMeshes.Add(Key, Mesh);
    TileCacheOrder.Add(Key);
    // New meshes are visible on registration, so record what actually ended up on screen.
    const bool Shown = VisibleTiles.Contains(Key) && !TileFailures.Contains(Key);
    Mesh->SetVisibility(Shown);
    if (Shown)
        ShownTiles.Add(Key);
    TrimTileCache();
}

void AGeoMap::TrimTileCache()
{
    constexpr int32 CacheLimit = 512;
    for (int32 Index = 0; TileMeshes.Num() > CacheLimit && Index < TileCacheOrder.Num();)
    {
        const FIntVector Key = TileCacheOrder[Index];
        if (VisibleTiles.Contains(Key))
        {
            ++Index;
            continue;
        }
        auto *Mesh = TileMeshes.FindRef(Key).Get();
        TileMeshes.Remove(Key);
        TileCacheOrder.RemoveAt(Index, EAllowShrinking::No);
        ShownTiles.Remove(Key);
        if (!IsValid(Mesh))
            continue;
        auto *Material = Cast<UMaterialInstanceDynamic>(Mesh->GetMaterial(0));
        UTexture *Texture = nullptr;
        if (Material)
            Material->GetTextureParameterValue(FMaterialParameterInfo(TEXT("Imagery")), Texture);
        Resources.Remove(Texture);
        Resources.Remove(Material);
        Resources.Remove(Mesh);
        Mesh->DestroyComponent();
    }
}

static FIntPoint TileAt(double Lon, double Lat, int32 Size)
{
    return FIntPoint(FMath::FloorToInt((Lon + 180) / 360 * Size),
        FMath::FloorToInt((1 - std::asinh(FMath::Tan(FMath::DegreesToRadians(FMath::Clamp(Lat, -85.0, 85.0)))) / PI) / 2 * Size));
}

void AGeoMap::RefreshTiles(double Lon, double Lat, double Range)
{
    int32 W = 1080, H = 1920;
    if (auto *PC = GetWorld()->GetFirstPlayerController())
        PC->GetViewportSize(W, H);
    const double TX = FMath::Tan(FMath::DegreesToRadians(Camera->FieldOfView * .5));
    const double TY = TX * H / FMath::Max(1, W);
    // Target approximately one source texel per display pixel at the subject.
    const double ProjectedWorld = 40075016.0 * FMath::Cos(FMath::DegreesToRadians(Lat)) * W / FMath::Max(1.0, 2 * TX * Range);
    const int32 Z = FMath::Clamp(FMath::CeilToInt(FMath::Log2(FMath::Max(1.0, ProjectedWorld / 256))), 3, 15);
    const int32 Size = 1 << Z;
    const FIntPoint Center = TileAt(Lon, Lat, Size);
    FIntPoint Min = Center, Max = Center;
    const FVector Target = Geo(Lon, Lat), Eye = Camera->GetComponentLocation();
    for (int SX : {-1, 1})
        for (int SY : {-1, 1})
        {
            const FVector Ray =
                Camera->GetForwardVector() + Camera->GetRightVector() * TX * SX + Camera->GetUpVector() * TY * SY;
            if (Ray.Z >= -.01)
                continue;
            const FVector Corner = Eye + Ray * ((Target.Z - Eye.Z) / Ray.Z);
            const double CornerLon = Lon + (Corner.Y - Target.Y) / (11132000 * FMath::Cos(FMath::DegreesToRadians(Lat)));
            const double CornerLat = Lat + (Corner.X - Target.X) / 11057000;
            const FIntPoint Tile = TileAt(CornerLon, CornerLat, Size);
            Min.X = FMath::Min(Min.X, Tile.X);
            Min.Y = FMath::Min(Min.Y, Tile.Y);
            Max.X = FMath::Max(Max.X, Tile.X);
            Max.Y = FMath::Max(Max.Y, Tile.Y);
        }
    Min.X = FMath::Max(Min.X, Center.X - 12);
    Min.Y = FMath::Clamp(Min.Y, FMath::Max(0, Center.Y - 12), Size - 1);
    Max.X = FMath::Min(Max.X, Center.X + 12);
    Max.Y = FMath::Clamp(Max.Y, 0, FMath::Min(Size - 1, Center.Y + 12));
    const FIntVector CenterKey(Center.X, Center.Y, Z);
    if (TileCenter == CenterKey && TileMin == Min && TileMax == Max)
        return;
    TileCenter = CenterKey;
    TileMin = Min;
    TileMax = Max;

    RequiredTiles.Reset();
    VisibleTiles.Reset();
    TileQueue.Reset();
    TMap<FIntVector, double> Plan;
    const int32 CoarseLevel = FMath::Max(2, Z - 2);
    for (int32 X = Min.X; X <= Max.X; ++X)
        for (int32 Y = Min.Y; Y <= Max.Y; ++Y)
        {
            const FIntVector Key((X % Size + Size) % Size, Y, Z);
            RequiredTiles.Add(Key);
            // Keep cached ancestors visible while detailed tiles arrive. Only
            // fetch a base level, one intermediate level and the final detail.
            for (int32 Level = Z; Level >= 2; --Level)
            {
                const int32 Shift = Z - Level;
                const FIntVector Parent(Key.X >> Shift, Key.Y >> Shift, Level);
                VisibleTiles.Add(Parent);
                if (Level != Z && Level != CoarseLevel && Level != 2)
                    continue;
                const double Distance = (FMath::Square(X - Center.X) + FMath::Square(Y - Center.Y)) / double(1 << (2 * Shift));
                const double Priority = Distance + (Level == 2 ? 0 : Level == CoarseLevel ? 100 : 500);
                if (auto *Existing = Plan.Find(Parent))
                    *Existing = FMath::Min(*Existing, Priority);
                else
                    Plan.Add(Parent, Priority);
            }
        }
    for (auto It = TileFailures.CreateIterator(); It; ++It)
        if (!VisibleTiles.Contains(*It))
            It.RemoveCurrent();
    for (auto It = TileAttempts.CreateIterator(); It; ++It)
        if (!VisibleTiles.Contains(It.Key()) && !ActiveTiles.Contains(It.Key()))
            It.RemoveCurrent();
    // Only edge tiles cross the boundary of the window between two refreshes, yet the
    // old loop re-asserted visibility on every cached mesh (a few hundred) on every
    // frame the camera moved, and each of those walks the render thread. Diff the set
    // and touch the handful that actually changed.
    for (auto It = ShownTiles.CreateIterator(); It; ++It)
    {
        if (VisibleTiles.Contains(*It))
            continue;
        if (auto *Mesh = TileMeshes.FindRef(*It).Get(); IsValid(Mesh))
            Mesh->SetVisibility(false);
        It.RemoveCurrent();
    }
    for (const FIntVector &Key : VisibleTiles)
    {
        if (ShownTiles.Contains(Key))
            continue;
        if (auto *Mesh = TileMeshes.FindRef(Key).Get(); IsValid(Mesh))
        {
            Mesh->SetVisibility(true);
            ShownTiles.Add(Key);
        }
    }
    for (const auto &Entry : Plan)
        if (!TileMeshes.Contains(Entry.Key) && !ActiveTiles.Contains(Entry.Key) && !TileFailures.Contains(Entry.Key))
            TileQueue.Add({Entry.Key, Entry.Value});
    TileQueue.Sort([](const FGeoTileRequest &A, const FGeoTileRequest &B) { return A.Priority > B.Priority; });
    TrimTileCache();
}
void AGeoMap::ApplyFrame(const TSharedPtr<FJsonObject> &Data)
{
    const double Started = FPlatformTime::Seconds();
    Frame = Data;
    auto C = O(Data, TEXT("camera"));
    double Lon = N(C, TEXT("lon"), OriginLon), Lat = N(C, TEXT("lat"), OriginLat), Range = N(C, TEXT("height"), 30000),
           Heading = FMath::DegreesToRadians(N(C, TEXT("heading"))),
           Pitch = FMath::DegreesToRadians(N(C, TEXT("pitch"), -64));
    FVector Target = Geo(Lon, Lat), Forward(FMath::Cos(Heading), FMath::Sin(Heading), 0),
            Position =
                Target - Forward * (Range * FMath::Cos(Pitch) * 100) + FVector(0, 0, -Range * FMath::Sin(Pitch) * 100);
    int32 ViewX = 1080, ViewY = 1920;
    if (auto *PC = GetWorld()->GetFirstPlayerController())
        PC->GetViewportSize(ViewX, ViewY);
    double Aspect = double(ViewX) / FMath::Max(1, ViewY);
    Camera->SetFieldOfView(Aspect >= 1 ? 60 : FMath::RadiansToDegrees(2 * FMath::Atan(FMath::Tan(PI / 6) * Aspect)));
    Camera->SetWorldLocationAndRotation(Position, (Target - Position).Rotation());
    const auto Trace = O(Data, TEXT("trace"));
    const FString FocusId = S(Data, TEXT("focusId"));
    // The parent's slab is the base of the whole scene: it grows in while its own
    // outline is drawn and then stays up for every later shot, so the map keeps its
    // relief when the tour moves down into the villages.
    const double BaseFocus = .16 * FMath::Clamp(N(Data, TEXT("parentReveal"), 1), 0., 1.);
    // The child's block is the highlight on top of that slab, so it still rises with
    // the trace head and follows the focus strength of its own shot.
    const double Rise = FocusId == S(Trace, TEXT("target"))
        ? FMath::SmoothStep(0., .25, N(Trace, TEXT("progress")))
        : 1.;
    // Villages whose shot has already started keep their plate, so the map gains
    // colour as the tour advances instead of erasing the previous village.
    TArray<FString> Visited;
    const TArray<TSharedPtr<FJsonValue>> *VisitedIds;
    if (Data->TryGetArrayField(TEXT("visitedIds"), VisitedIds))
        for (const auto &Value : *VisitedIds)
        {
            const FString Id = Value->AsString();
            if (!Id.IsEmpty() && Id != FocusId)
                Visited.Add(Id);
        }
    UpdateBoundaryEffects(FocusId, Visited, BaseFocus, .16 * N(Data, TEXT("focus")) * Rise, N(Data, TEXT("mapTime")));
    if (Sky)
    {
        // Pierce factor: where the camera physically sits inside the 1.5-3.5 km deck,
        // plus the scripted opening pass so the graded "through the clouds" beat still
        // reads when the shot stays above the layer.
        const FVector CameraLocation = Camera->GetComponentLocation();
        const double Scripted = N(O(Data, TEXT("clouds")), TEXT("volume"));
        Sky->UpdateView(CameraLocation, Camera->GetForwardVector(), CameraLocation.Z / 100.0, Scripted);
        const double Pierce = Sky->GetPierce();
        const double Burst = Sky->GetExitBurst();
        // The deck is a real 1.5-3.5 km layer and reads as opaque, so it may only be
        // visible while a shot asks for cloud. Left on, it sits between the ~27 km
        // camera and the map and blanks the imagery.
        Sky->SetDeckOpacity(Pierce);
        if (PostProcess)
        {
            FPostProcessSettings &Settings = PostProcess->Settings;
            // Inside the deck the light has to fall off: pull exposure down, drop the
            // bloom threshold so the cloud edge still glows a little, and close the
            // corners in. Punching out of the top reverses all three and flashes.
            // The drop stays around one stop: pushing further turned the deck orange,
            // because ACES lifts red and green faster than blue in the low end.
            Settings.AutoExposureBias = -1.3 * Pierce + 1.25 * Burst;
            Settings.BloomIntensity = 1.0 + 3.2 * Burst + .5 * Pierce;
            Settings.BloomThreshold = 1.1 - .55 * Burst;
            Settings.VignetteIntensity = .35 + .5 * Pierce;
        }
        static int32 SkyReport = 0;
        if (++SkyReport % 90 == 0)
            UE_LOG(LogTemp, Display, TEXT("GEO_SKY deck=%.2f pierce=%.2f bias=%.2f tiles=%d visible=%d"),
                   Sky->GetDeckOpacity(), Sky->GetPierce(),
                   PostProcess ? PostProcess->Settings.AutoExposureBias : 0.f, TileMeshes.Num(),
                   VisibleTiles.Num());
    }
    const double BeforeTiles = FPlatformTime::Seconds();
    RefreshTiles(Lon, Lat, Range);
    RefreshMs = FMath::Lerp(RefreshMs, (FPlatformTime::Seconds() - BeforeTiles) * 1000., .1);
    ApplyMs = FMath::Lerp(ApplyMs, (FPlatformTime::Seconds() - Started) * 1000., .1);
}
void AGeoMap::UpdateTileCounts()
{
    PendingTiles = FailedTiles = 0;
    for (const auto &Key : RequiredTiles)
        if (!TileMeshes.Contains(Key))
        {
            if (TileFailures.Contains(Key))
                ++FailedTiles;
            else
                ++PendingTiles;
        }
}

void AGeoMap::Tick(float Delta)
{
    Super::Tick(Delta);
    AverageFrameMs = AverageFrameMs == 0 ? Delta * 1000 : FMath::Lerp(AverageFrameMs, double(Delta * 1000), .05);
    // Both halves of the tile pipeline are rate-limited. A camera move opens a new
    // window of tiles several times a second; letting it fire eighteen requests and
    // eighteen texture uploads inside one frame is what dropped a moving shot to ~18
    // fps. Four per frame carries the same throughput over a second without any burst.
    constexpr int32 MaxActiveTiles = 12, SpawnsPerTick = 4, UploadsPerTick = 4;
    for (int32 Spawned = 0; Spawned < SpawnsPerTick && ActiveTiles.Num() < MaxActiveTiles && !TileQueue.IsEmpty();
         ++Spawned)
        StartTile(TileQueue.Pop(EAllowShrinking::No).Tile);
    for (int32 Uploaded = 0; Uploaded < UploadsPerTick && !TileImages.IsEmpty(); ++Uploaded)
    {
        FGeoTileImage Image = MoveTemp(TileImages[0]);
        TileImages.RemoveAt(0, EAllowShrinking::No);
        if (Image.Generation == Generation && VisibleTiles.Contains(Image.Key))
            CommitTile(MoveTemp(Image));
    }
    static int32 ProfileReport = 0;
    if (++ProfileReport % 90 == 0)
        UE_LOG(LogTemp, Display,
               TEXT("GEO_PROFILE fps=%.1f frame=%.1fms apply=%.2fms refresh=%.2fms hud=%.2fms (rings=%.2f mask=%.2f) tiles=%d shown=%d "
                    "queued=%d active=%d uploads=%d rects=%d ringPoints=%d"),
               1000. / FMath::Max(1e-3, AverageFrameMs), AverageFrameMs, ApplyMs, RefreshMs, HudMs,
               HudRingsMs, HudMaskMs,
               TileMeshes.Num(), ShownTiles.Num(), TileQueue.Num(), ActiveTiles.Num(), TileImages.Num(),
               HudRects, BoundaryVertices);
    if (CaptureId.IsEmpty())
        return;
    UpdateTileCounts();
    if (FPlatformTime::Seconds() - CaptureStarted > 45)
    {
        Respond(CaptureId, TEXT("Timed out waiting for imagery"));
        CaptureId.Empty();
        return;
    }
    if (PendingTiles > 0 || (TileMaterial && TileMaterial->IsCompiling()) || BoundaryEffectsCompiling())
    {
        CaptureTicks = 0;
        return;
    }
    if (++CaptureTicks < 4)
        return;
    FString Id = CaptureId;
    CaptureId.Empty();
    if (FailedTiles > 0)
    {
        Respond(Id, TEXT("Imagery tile errors; frame capture refused"));
        return;
    }
    FString File = FPaths::Combine(CaptureRoot, FString::Printf(TEXT("frame-%06d.png"), CaptureIndex++));
    IFileManager::Get().MakeDirectory(*CaptureRoot, true);
    UGameViewportClient::OnScreenshotCaptured().AddWeakLambda(
        this, [this, Id, File](int32 Width, int32 Height, const TArray<FColor> &Pixels) {
            TArray<FColor> Opaque = Pixels;
            for (auto &P : Opaque)
                P.A = 255;
            TArray64<uint8> PNG;
            FImageUtils::PNGCompressImageArray(Width, Height, Opaque, PNG);
            bool Saved = FFileHelper::SaveArrayToFile(PNG, *File);
            Respond(Id, Saved ? TEXT("") : TEXT("Unable to save PNG frame"));
            UGameViewportClient::OnScreenshotCaptured().RemoveAll(this);
        });
    FScreenshotRequest::RequestScreenshot(File, false, false);
}
// Clip a region to the near plane and the output rectangle before masking.
// This keeps a close village shot valid even when most parent vertices are behind the camera.
static TArray<FVector2D> ProjectFocusRing(const TArray<FVector> &Input, UCameraComponent *Camera, int W, int H)
{
    const FVector Eye = Camera->GetComponentLocation(), Forward = Camera->GetForwardVector();
    TArray<FVector> World;
    if (Input.Num() < 3)
        return {};
    FVector A = Input.Last();
    double DA = FVector::DotProduct(A - Eye, Forward) - 1;
    for (const auto &B : Input)
    {
        const double DB = FVector::DotProduct(B - Eye, Forward) - 1;
        if ((DA >= 0) != (DB >= 0))
            World.Add(FMath::Lerp(A, B, DA / (DA - DB)));
        if (DB >= 0)
            World.Add(B);
        A = B;
        DA = DB;
    }
    const double TX = FMath::Tan(FMath::DegreesToRadians(Camera->FieldOfView * .5)), TY = TX * H / FMath::Max(1, W);
    TArray<FVector2D> Result;
    for (const auto &P : World)
    {
        const FVector D = P - Eye;
        const double Depth = FVector::DotProduct(D, Forward);
        Result.Add(FVector2D(W * .5 * (1 + FVector::DotProduct(D, Camera->GetRightVector()) / Depth / TX),
                             H * .5 * (1 - FVector::DotProduct(D, Camera->GetUpVector()) / Depth / TY)));
    }
    for (int Side = 0; Side < 4; Side++)
    {
        if (Result.Num() < 3)
            return {};
        auto Distance = [Side, W, H](const FVector2D &P) {
            return Side == 0 ? P.X : Side == 1 ? W - P.X : Side == 2 ? P.Y : H - P.Y;
        };
        TArray<FVector2D> Next;
        FVector2D Previous = Result.Last();
        double Before = Distance(Previous);
        for (const auto &Point : Result)
        {
            const double After = Distance(Point);
            if ((Before >= 0) != (After >= 0))
                Next.Add(FMath::Lerp(Previous, Point, Before / (Before - After)));
            if (After >= 0)
                Next.Add(Point);
            Previous = Point;
            Before = After;
        }
        Result = MoveTemp(Next);
    }
    return Result;
}
void AGeoHUD::DrawHUD()
{
    Super::DrawHUD();
    auto *Map = Cast<AGeoMap>(UGameplayStatics::GetActorOfClass(GetWorld(), AGeoMap::StaticClass()));
    if (!Map || !Map->Frame || !Canvas)
        return;
    const auto F = Map->Frame;
    const FString Current = S(F, TEXT("current"));
    const FString FocusId = S(F, TEXT("focusId"));
    const float Scale = Canvas->SizeX / (Map->RenderProfile == TEXT("landscape") ? 1920.f : 1080.f);
    const FIntPoint Size(Canvas->SizeX, Canvas->SizeY);
    // The HUD costs a projection per boundary vertex, every frame: 12.5k points for the
    // county ring alone, 46k once the villages are toured. APlayerController's version
    // re-resolves the view point and the viewport for every single call, which is what
    // kept a moving shot at 18 fps while an idle one sat happily at the cap. One matrix,
    // built once, and every point is a single multiply.
    const FMatrix ViewProjection = Canvas->SceneView ? Canvas->SceneView->ViewMatrices.GetViewProjectionMatrix() : FMatrix::Identity;
    const bool bCanvasProjection = Canvas->SceneView != nullptr;
    struct FHudTimer
    {
        AGeoMap *Map;
        double Started;
        ~FHudTimer() { Map->HudMs = FMath::Lerp(Map->HudMs, (FPlatformTime::Seconds() - Started) * 1000., .1); }
    };
    const FHudTimer Timer{Map, FPlatformTime::Seconds()};
    // Timestamp of the ring/fill half, used to split the HUD cost in GEO_PROFILE.
    double RingsDone = Timer.Started;
    const auto ToScreen = [this, &ViewProjection, &Size, bCanvasProjection](const FVector &World, FVector2D &Pixel) {
        if (!bCanvasProjection)
            return PlayerOwner->ProjectWorldLocationToScreen(World, Pixel);
        const FVector4 Clip = ViewProjection.TransformFVector4(FVector4(World, 1.0));
        if (Clip.W <= KINDA_SMALL_NUMBER)
            return false;
        const double RHW = 1.0 / Clip.W;
        Pixel.X = (Clip.X * RHW * .5 + .5) * Size.X;
        Pixel.Y = (-Clip.Y * RHW * .5 + .5) * Size.Y;
        return true;
    };
    const double Focus = N(F, TEXT("focus")), Reveal = N(F, TEXT("parentReveal"));
    const double ChildReveal = N(F, TEXT("childReveal"), 1);
    const auto Trace = O(F, TEXT("trace"));
    const auto Accents = O(F, TEXT("accents"));
    const auto FillStrengths = O(F, TEXT("fills"));
    const auto Styles = O(F, TEXT("labels"));
    const auto ContextCamera = O(F, TEXT("camera"));
    const double CameraHeight = N(ContextCamera, TEXT("height"), 30000);
    const double ContextSpanMeters = Map->ContextBounds.IsValid ? Map->ContextBounds.GetSize().Size2D() / 100.0 : 0;
    // The county is drawn on its own clock: `contextReveal` traces the outline and
    // `contextOpacity` fades the whole context layer, so the town can finish first.
    const double ContextReveal = FMath::Clamp(N(F, TEXT("contextReveal"), 1), 0., 1.);
    const double ContextOpacity = FMath::Clamp(N(F, TEXT("contextOpacity"), 1), 0., 1.);
    // One gate for every name on the opening shot. The player keeps it at zero while
    // the camera is still inside the cloud deck and only opens it after the boundary
    // beam has swept the rim, so no label can leak into the descent.
    const double LabelsReveal = FMath::Clamp(N(F, TEXT("labelsReveal"), 1), 0., 1.);
    const double ContextAlpha = Map->HasContext && ContextSpanMeters > 1
        ? FMath::SmoothStep(.55, 1.25, CameraHeight / ContextSpanMeters) * ContextOpacity
        : 0;
    if (LabelGeneration != Map->Generation || CachedSize != Size)
    {
        LabelGeneration = Map->Generation;
        LabelPlacements.Reset();
        LabelPlates.Reset();
    }
    if (CachedFrame != F || CachedSize != Size)
    {
        CachedFrame = F;
        CachedSize = Size;
        Strokes.Reset();
        FocusTriangles.Reset();
        VisitedFills.Reset();
        DimRects.Reset();
        for (auto &Layer : ShadowRects)
            Layer.Reset();
        // The dim sheet and its contact shadow are cut out of the TOWNSHIP, not out of
        // whichever child is currently on screen. Cutting the hole out of the focused
        // village darkened the rest of 迈陈镇 during a village shot, so the township's
        // own imagery went grey while its villages were being read. The hole is the
        // township for the whole film; the village accent is drawn as fill and outline.
        // `Reveal` (the township rim being traced) is what fades it in, so the descent
        // still starts on a clean image.
        TArray<TArray<FVector2D>> MaskRings;
        const FGeoRing *TraceRing = nullptr;
        if (N(Trace, TEXT("alpha")) > .01)
            for (const auto &Ring : Map->Rings)
                if ((Current.IsEmpty() ? Ring.Parent : Ring.Id == Current) && Ring.Points.Num() >= 4 &&
                    (!TraceRing || Ring.Lengths.Last() > TraceRing->Lengths.Last()))
                    TraceRing = &Ring;
        for (const auto &Ring : Map->Rings)
        {
            if (Ring.Parent && Reveal > .001 && Ring.Points.Num() >= 4)
                MaskRings.Add(ProjectFocusRing(Ring.Points, Map->Camera, Size.X, Size.Y));
            const double Accent = Ring.Parent ? N(F, TEXT("parentAccent")) : N(Accents, *Ring.Id);
            // Visited villages keep a thin outline for the rest of the film, so the
            // accumulated green still reads as separate places instead of one blob.
            const bool Show = Ring.Parent ||
                              (ChildReveal > .01 && (Ring.Id == Current || Map->BoundaryVisited.Contains(Ring.Id)));
            if (!Show || Ring.Points.Num() < 2)
                continue;
            FVector2D A;
            bool HasA = ToScreen(Ring.Points[0], A);
            const double Length = Ring.Lengths.IsEmpty() ? 1 : FMath::Max(1., Ring.Lengths.Last());
            for (int I = 1; I < Ring.Points.Num(); I++)
            {
                FVector2D B;
                const bool HasB = ToScreen(Ring.Points[I], B);
                if (HasA && HasB &&
                    !(FMath::Max(A.X, B.X) < -20 || FMath::Min(A.X, B.X) > Size.X + 20 || FMath::Max(A.Y, B.Y) < -20 ||
                      FMath::Min(A.Y, B.Y) > Size.Y + 20))
                    Strokes.Add(
                        {A, B, Ring.Parent, &Ring == TraceRing, Ring.Id == Current, Ring.Lengths[I - 1] / Length,
                         Ring.Lengths[I] / Length, Accent});
                A = B;
                HasA = HasB;
            }
        }
        for (const auto &Fill : Map->Fills)
        {
            // The fill of the town itself, on the opening shot. Village fill is no longer
            // the focused fill: it lives in `fills`, ramps in on the flight over and then
            // stays for the rest of the film, so it is handled below for every village.
            if (Focus <= .001 || !FocusId.IsEmpty() || !Fill.Parent)
                continue;
            TArray<FVector2D> Points;
            TArray<bool> Valid;
            for (const auto &Vertex : Fill.Vertices)
            {
                FVector2D Pixel;
                Valid.Add(ToScreen(Vertex, Pixel));
                Points.Add(Pixel);
            }
            for (int I = 0; I + 2 < Fill.Indices.Num(); I += 3)
            {
                const int A = Fill.Indices[I], B = Fill.Indices[I + 1], C = Fill.Indices[I + 2];
                if (!Valid[A] || !Valid[B] || !Valid[C])
                    continue;
                FCanvasUVTri Triangle;
                Triangle.V0_Pos = Points[A];
                Triangle.V1_Pos = Points[B];
                Triangle.V2_Pos = Points[C];
                Triangle.V0_UV = Triangle.V1_UV = Triangle.V2_UV = FVector2D::ZeroVector;
                Triangle.V0_Color = Triangle.V1_Color = Triangle.V2_Color = FLinearColor::White;
                FocusTriangles.Add(Triangle);
            }
        }
        // Villages whose tour already started keep the same saturated fill they carried
        // while they were the subject. It used to be the focused fill only, so the green
        // dropped to the pale plate as soon as the tour moved on and the place looked
        // switched off; now the paint is permanent and the map accumulates.
        for (const auto &Fill : Map->Fills)
        {
            if (Fill.Parent)
                continue;
            const double Strength = N(FillStrengths, *Fill.Id);
            if (Strength <= .01)
                continue;
            TArray<FVector2D> Points;
            TArray<bool> Valid;
            for (const auto &Vertex : Fill.Vertices)
            {
                FVector2D Pixel;
                Valid.Add(ToScreen(Vertex, Pixel));
                Points.Add(Pixel);
            }
            FGeoVisitedFill Painted;
            const FLinearColor Tint(.20, .62, .20, .55 * Strength);
            for (int I = 0; I + 2 < Fill.Indices.Num(); I += 3)
            {
                const int A = Fill.Indices[I], B = Fill.Indices[I + 1], C = Fill.Indices[I + 2];
                if (!Valid[A] || !Valid[B] || !Valid[C])
                    continue;
                FCanvasUVTri Triangle;
                Triangle.V0_Pos = Points[A];
                Triangle.V1_Pos = Points[B];
                Triangle.V2_Pos = Points[C];
                Triangle.V0_UV = Triangle.V1_UV = Triangle.V2_UV = FVector2D::ZeroVector;
                Triangle.V0_Color = Triangle.V1_Color = Triangle.V2_Color = Tint;
                Painted.Triangles.Add(Triangle);
            }
            if (Painted.Triangles.Num())
                VisitedFills.Add(MoveTemp(Painted));
        }
        RingsDone = FPlatformTime::Seconds();
        // Active-edge sweep: mask outside all focused rings using even/odd parity,
        // including holes and islands. Cost scales with visible edges, not pixels.
        struct Edge
        {
            double X, Step;
            int End;
        };
        // ---- frames taken from inside the township -------------------------------
        // The hole in the dim sheet is the township rim, so a village close-up has to show
        // no dimming at all: the camera is standing inside the hole. Clipping that rim to
        // the frustum used to fail once it fell behind the camera, which left the sweep
        // with no boundary — every scanline counted as exterior and the frame went as dark
        // inside 迈陈镇 as outside it. Two checks prevent that: if all four screen corners
        // read inside the projected rim, the frame is all township; and if the rim was
        // clipped away entirely, the camera's own ground point decides.
        const auto InsideRim = [&MaskRings](const FVector2D &Pixel) {
            bool In = false;
            for (const auto &Ring : MaskRings)
                for (int32 I = 0, J = Ring.Num() - 1; I < Ring.Num(); J = I++)
                    if (((Ring[I].Y > Pixel.Y) != (Ring[J].Y > Pixel.Y)) &&
                        Pixel.X < (Ring[J].X - Ring[I].X) * (Pixel.Y - Ring[I].Y) / (Ring[J].Y - Ring[I].Y) + Ring[I].X)
                        In = !In;
            return In;
        };
        // `ProjectFocusRing` returns an EMPTY ARRAY, not nothing, when the rim is clipped
        // away — so the list is never empty and a naive check would still sweep a frame
        // with no boundary at all. Only rings with real points count as a usable rim.
        bool HasRim = false;
        for (const auto &Ring : MaskRings)
            if (Ring.Num() >= 3)
            {
                HasRim = true;
                break;
            }
        // 相机脚下的地面点是否落在镇内：洞失效时的最后一道判据。
        bool CameraOverTown = false;
        {
            const FVector Eye = Map->Camera->GetComponentLocation(), Fwd = Map->Camera->GetForwardVector();
            if (Fwd.Z < -.01)
            {
                const FVector Ground = Eye - Fwd * (Eye.Z / Fwd.Z);
                for (const auto &Ring : Map->Rings)
                {
                    if (!Ring.Parent || Ring.Points.Num() < 4)
                        continue;
                    const int32 Stride = FMath::Max(1, Ring.Points.Num() / 400);
                    for (int32 I = 0; I < Ring.Points.Num(); I += Stride)
                    {
                        const FVector &A = Ring.Points[I];
                        const FVector &B = Ring.Points[(I + Stride) % Ring.Points.Num()];
                        if (((A.Y > Ground.Y) != (B.Y > Ground.Y)) &&
                            Ground.X < (B.X - A.X) * (Ground.Y - A.Y) / (B.Y - A.Y) + A.X)
                            CameraOverTown = !CameraOverTown;
                    }
                }
            }
        }
        bool TownFillsView = false;
        if (HasRim)
        {
            int32 Inside = 0;
            for (const FVector2D &Corner :
                 {FVector2D(0, 0), FVector2D(Size.X, 0), FVector2D(0, Size.Y), FVector2D(Size.X, Size.Y)})
                Inside += InsideRim(Corner) ? 1 : 0;
            TownFillsView = Inside == 4;
        }
        else
        {
            TownFillsView = CameraOverTown;
        }
        const int Band = 2, Rows = (TownFillsView || !HasRim) ? 0 : FMath::CeilToInt(double(Size.Y) / Band);
        TArray<TArray<Edge>> Starts;
        Starts.SetNum(Rows);
        using FSpans = TArray<FVector2D, TInlineAllocator<4>>;
        TArray<FSpans> InsideRows, OutsideRows;
        InsideRows.SetNum(Rows);
        OutsideRows.SetNum(Rows);
        TArray<Edge> Active;
        for (const auto &Ring : MaskRings)
            for (int I = 0; I < Ring.Num(); I++)
            {
                FVector2D A = Ring[I], B = Ring[(I + 1) % Ring.Num()];
                if (FMath::Abs(A.Y - B.Y) < .001)
                    continue;
                if (A.Y > B.Y)
                    Swap(A, B);
                const int First = FMath::Clamp(FMath::CeilToInt((A.Y - Band * .5) / Band), 0, Rows),
                          End = FMath::Clamp(FMath::CeilToInt((B.Y - Band * .5) / Band), 0, Rows);
                if (First >= End)
                    continue;
                const double DX = (B.X - A.X) / (B.Y - A.Y);
                Starts[First].Add({A.X + (First * Band + Band * .5 - A.Y) * DX, DX * Band, End});
            }
        for (int Row = 0; Row < Rows; Row++)
        {
            Active.RemoveAll([Row](const Edge &E) { return E.End <= Row; });
            Active.Append(Starts[Row]);
            Active.Sort([](const Edge &A, const Edge &B) { return A.X < B.X; });
            double Left = 0;
            for (int I = 0; I < Active.Num(); I += 2)
            {
                const double Right = FMath::Clamp(Active[I].X, 0., double(Size.X));
                if (Right > Left)
                    OutsideRows[Row].Emplace(Left, Right);
                Left = I + 1 < Active.Num() ? FMath::Clamp(Active[I + 1].X, 0., double(Size.X)) : Size.X;
                if (Left > Right)
                    InsideRows[Row].Emplace(Right, Left);
            }
            if (Left < Size.X)
                OutsideRows[Row].Emplace(Left, Size.X);
            for (auto &E : Active)
                E.X += E.Step;
        }
        // Dilate the silhouette in three soft steps, shifted down toward the
        // ground. Clip each step to the exact exterior spans, including holes.
        const double Radii[] = {13, 7, 3.5};
        const double Drops[] = {3, 4, 3.5};
        for (int Row = 0; Row < Rows; ++Row)
        {
            const double Height = FMath::Min(Band, Size.Y - Row * Band);
            for (const FVector2D &Gap : OutsideRows[Row])
                DimRects.Emplace(Gap.X, Row * Band, Gap.Y - Gap.X, Height);
            if (OutsideRows[Row].IsEmpty())
                continue;
            for (int Layer = 0; Layer < UE_ARRAY_COUNT(Radii); ++Layer)
            {
                const double Radius = Radii[Layer] * Scale;
                const int Center = Row - FMath::RoundToInt(Drops[Layer] * Scale / Band);
                const int Range = FMath::FloorToInt(Radius / Band);
                TArray<FVector2D, TInlineAllocator<32>> Candidates;
                for (int Sample = FMath::Max(0, Center - Range); Sample <= FMath::Min(Rows - 1, Center + Range); ++Sample)
                {
                    const double Spread = FMath::Sqrt(FMath::Max(0., FMath::Square(Radius) - FMath::Square(double((Sample - Center) * Band))));
                    for (const FVector2D &Span : InsideRows[Sample])
                        Candidates.Emplace(Span.X - Spread, Span.Y + Spread);
                }
                Candidates.Sort([](const FVector2D &A, const FVector2D &B) { return A.X < B.X; });
                for (const FVector2D &Gap : OutsideRows[Row])
                {
                    double End = Gap.X;
                    for (const FVector2D &Span : Candidates)
                    {
                        if (Span.X >= Gap.Y)
                            break;
                        const double Left = FMath::Max(End, Span.X), Right = FMath::Min(Gap.Y, Span.Y);
                        if (Right <= Left)
                            continue;
                        ShadowRects[Layer].Emplace(Left, Row * Band, Right - Left, Height);
                        End = Right;
                    }
                }
            }
        }
        // Last line of defence: the camera is inside the township yet the sheet covers
        // almost the whole frame, so the hole did not take (rim clipped away, or entirely
        // off screen). Dimming the whole picture is the one outcome that must never ship —
        // a village shot has to read as normal imagery.
        if (CameraOverTown && Rows > 0)
        {
            double DimArea = 0;
            for (const auto &Rect : DimRects)
                DimArea += double(Rect.Z) * double(Rect.W);
            // 97 %, not 85 %: a village shot legitimately darkens the strip of neighbouring
            // townships along the top and bottom, and that is the effect being kept. Only a
            // sheet that covers essentially everything means the hole failed.
            if (DimArea > .97 * double(Size.X) * double(Size.Y))
            {
                DimRects.Reset();
                for (auto &Layer : ShadowRects)
                    Layer.Reset();
            }
        }
    }
    Map->HudRingsMs = FMath::Lerp(Map->HudRingsMs, (RingsDone - Timer.Started) * 1000., .1);
    Map->HudMaskMs = FMath::Lerp(Map->HudMaskMs, (FPlatformTime::Seconds() - RingsDone) * 1000., .1);
    Map->HudRects = DimRects.Num();
    for (const auto &Layer : ShadowRects)
        Map->HudRects += Layer.Num();
    // The dim sheet and its three shadow steps are built per scanline, so a shot with
    // the county focused emits six thousand quads per frame. Submitted one FCanvasTileItem
    // at a time that was 5.7 ms of the render thread — six thousand item constructions for
    // what is one colour over one shape. Batch each layer into a single triangle item:
    // same pixels, four draw calls instead of six thousand.
    const auto DrawRects = [this](const TArray<FVector4> &Rects, const FLinearColor &Color) {
        for (const auto &Rect : Rects)
        {
            FCanvasTileItem Tile(FVector2D(Rect.X, Rect.Y), FVector2D(Rect.Z, Rect.W), Color);
            Tile.BlendMode = SE_BLEND_Translucent;
            Canvas->DrawItem(Tile);
        }
    };
    // Keyed off the township's own reveal, not the shot's focus strength: the periphery
    // stays dimmed from the opening to the outro instead of breathing with each cut.
    // One sheet for every shot: the brief is the periphery reads 70 % darker than the
    // township itself, in a village close-up as much as in the overview. The old split
    // (.48 overview / .22 focused) left the periphery at half strength whenever a village
    // had the frame, which read as "no dimming at all" next to the undimmed township.
    const double DimOpacity = .72;
    DrawRects(DimRects, FLinearColor(.018, .024, .022, DimOpacity * Reveal));
    const double ShadowOpacity[] = {.08, .15, .33};
    for (int Layer = 0; Layer < UE_ARRAY_COUNT(ShadowRects); ++Layer)
        DrawRects(ShadowRects[Layer], FLinearColor(.006, .010, .010, ShadowOpacity[Layer] * Reveal));
    // The county arrives as a wipe: a straight front travels across the shape and
    // everything behind it is drawn, nothing ahead of it is. The front is placed on
    // the polygon's own projected extent — the world-space AABB projects far wider
    // than the county once perspective is in play, which made the wipe finish early —
    // so it starts at one edge and lands just past the other. `contextErasing` says
    // which way the front is travelling, which only tints the cut.
    const double Wipe = FMath::Clamp(ContextReveal, 0., 1.);
    const double Erasing = FMath::Clamp(N(F, TEXT("contextErasing"), 0), 0., 1.);
    // ---- county flood ---------------------------------------------------------
    // The county no longer arrives as a straight wipe. A distance field is measured
    // from the township centre (that is where the shot is aimed and where the story
    // starts) and the fill is drawn only where that distance is still under a radius
    // that grows with `contextReveal`. The radius carries three slow sine lobes and a
    // fine jitter per scanline, faded out as the flood finishes, so the front creeps
    // and nibbles at the county instead of sliding across it as one edge. Everything
    // is a pure function of the frame time, so the offline capture stays deterministic.
    TArray<TArray<FVector2D>> CountyScreen;
    bool CountyFramed = false;
    FVector2D Seed(Size.X * .5, Size.Y * .5);
    for (const auto &Ring : Map->ContextRings)
    {
        TArray<FVector2D> Screen;
        bool WholeRing = Ring.Points.Num() >= 3;
        for (const FVector &Point : Ring.Points)
        {
            FVector2D Pixel;
            if (!ToScreen(Point, Pixel))
            {
                WholeRing = false;
                break;
            }
            Screen.Add(Pixel);
        }
        if (WholeRing)
            CountyScreen.Add(MoveTemp(Screen));
    }
    {
        // The township label is the anchor: the flood has to start where the viewer is
        // already looking. The county label is only a fallback for frames where the
        // township is off screen.
        bool Anchored = false;
        for (const auto &Label : Map->Labels)
            if (Label.Parent)
            {
                FVector2D Pixel;
                if (ToScreen(Label.Position, Pixel))
                {
                    Seed = Pixel;
                    Anchored = true;
                }
            }
        if (!Anchored)
        {
            FVector2D Pixel;
            if (ToScreen(Map->ContextLabel.Position, Pixel))
                Seed = Pixel;
        }
        CountyFramed = !CountyScreen.IsEmpty();
    }
    double Reach = 1.;
    for (const auto &Ring : CountyScreen)
        for (const FVector2D &Pixel : Ring)
            Reach = FMath::Max(Reach, double(FVector2D::Distance(Pixel, Seed)));
    const double MapTime = N(F, TEXT("mapTime"));
    // Lobes on the order of tens of pixels, jitter on the order of one: that ragged
    // edge is what stops the front reading as a circle. Faded at the very end so the
    // county closes clean and the crest does not linger on a finished shape.
    const double LobeFade = 1. - FMath::SmoothStep(.86, 1., Wipe);
    const double Jitter = 32. * Scale;
    // Radius at Wipe 1 lands exactly on Reach so nothing is left uncovered; at Wipe 0 it
    // is negative and the county is empty. Slightly slower than linear so the flood
    // leaves the seed deliberately instead of snapping out to half the county.
    const double BaseRadius = (Reach + Jitter) * FMath::Pow(Wipe, 1.1) - Jitter;
    // Lobes are measured around the seed, not per scanline: that is what makes the front
    // push out in tongues and leave the straight-edge look behind. Three harmonics at
    // incommensurate frequencies, drifting slowly, so no two frames repeat the same edge.
    const auto Angular = [&](double Angle) {
        return 1. + LobeFade * (.10 * FMath::Sin(3. * Angle + MapTime * .8)
                                + .055 * FMath::Sin(5. * Angle - MapTime * 1.15)
                                + .025 * FMath::Sin(11. * Angle + MapTime * 1.9));
    };
    // A fine per-scanline tremor on top of the lobes: the torn edge of something that is
    // eating its way across the imagery rather than a clean circle.
    const auto RowJitter = [&](double RowY) {
        return Scale * LobeFade *
            (2.6 * FMath::Sin(RowY * .37 - MapTime * 2.7) + 1.2 * FMath::Sin(RowY * .91 + MapTime * 4.1));
    };
    const auto FrontAt = [&](const FVector2D &Pixel) {
        const FVector2D Delta = Pixel - Seed;
        return BaseRadius * Angular(FMath::Atan2(Delta.Y, Delta.X)) + RowJitter(Pixel.Y);
    };
    const auto Reached = [&](const FVector2D &Pixel) {
        return FVector2D::Distance(Pixel, Seed) <= FrontAt(Pixel);
    };
    const auto CutAtFront = [&](const FVector2D &Inside, const FVector2D &Outside) {
        FVector2D Near = Inside, Far = Outside;
        for (int Step = 0; Step < 7; ++Step)
        {
            const FVector2D Middle = (Near + Far) * .5;
            if (Reached(Middle))
                Near = Middle;
            else
                Far = Middle;
        }
        return Near;
    };
    if (ContextAlpha > .01 && Wipe > .0005 && CountyFramed)
    {
        // Scanline fill of the projected county, clipped to the distance field. The
        // even/odd parity pass is the same one the dim mask uses, so holes and islands
        // come out right without going through earcut again.
        const FLinearColor FloodBody(.05, .28, .66, .30 * ContextAlpha);
        const FLinearColor WetLip(.44, .74, .98, (Erasing > .01 ? .09 : .17) * ContextAlpha);
        const int Band = 2, Rows = FMath::CeilToInt(double(Size.Y) / Band);
        struct FFloodSpan
        {
            double X, Step;
            int End;
        };
        TArray<TArray<FFloodSpan>> Starts;
        Starts.SetNum(Rows);
        for (const auto &Ring : CountyScreen)
        {
            for (int I = 0; I < Ring.Num(); I++)
            {
                FVector2D A = Ring[I], B = Ring[(I + 1) % Ring.Num()];
                if (FMath::Abs(A.Y - B.Y) < .001)
                    continue;
                if (A.Y > B.Y)
                    Swap(A, B);
                const int First = FMath::Clamp(FMath::CeilToInt((A.Y - Band * .5) / Band), 0, Rows),
                          Last = FMath::Clamp(FMath::CeilToInt((B.Y - Band * .5) / Band), 0, Rows);
                if (First >= Last)
                    continue;
                const double DX = (B.X - A.X) / (B.Y - A.Y);
                Starts[First].Add({A.X + (First * Band + Band * .5 - A.Y) * DX, DX * Band, Last});
            }
        }
        TArray<FFloodSpan> Active;
        const double LipWidth = FMath::Max(3.0, 7.0 * Scale);
        for (int Row = 0; Row < Rows; Row++)
        {
            Active.RemoveAll([Row](const FFloodSpan &Span) { return Span.End <= Row; });
            Active.Append(Starts[Row]);
            Active.Sort([](const FFloodSpan &A, const FFloodSpan &B) { return A.X < B.X; });
            const double RowY = Row * Band + Band * .5;
            const double Height = FMath::Min(double(Band), double(Size.Y - Row * Band));
            const double Dy = RowY - Seed.Y;
            // The field is polar, so each side of a row has its own crossing: solve for
            // the half width, re-read the angle at the crossing, and settle. Two passes
            // are enough — the lobes are smooth and this is a HUD, not a raytracer.
            const auto HalfWidth = [&](double Direction) {
                double Radius = BaseRadius * Angular(FMath::Atan2(Dy, Direction)) + RowJitter(RowY);
                double Square = Radius * Radius - Dy * Dy;
                for (int Step = 0; Step < 2 && Square > 0.; ++Step)
                {
                    const double Try = FMath::Sqrt(Square);
                    Radius = BaseRadius * Angular(FMath::Atan2(Dy, Direction * Try)) + RowJitter(RowY);
                    Square = Radius * Radius - Dy * Dy;
                }
                return Square > 0. ? FMath::Sqrt(Square) : 0.;
            };
            const double HalfL = HalfWidth(-1.), HalfR = HalfWidth(1.);
            if (HalfL + HalfR > .5)
            {
                for (int I = 0; I + 1 < Active.Num(); I += 2)
                {
                    const double Left = FMath::Max(Active[I].X, Seed.X - HalfL);
                    const double Right = FMath::Min(Active[I + 1].X, Seed.X + HalfR);
                    if (Right <= Left)
                        continue;
                    FCanvasTileItem Body(FVector2D(Left, Row * Band), FVector2D(Right - Left, Height), FloodBody);
                    Body.BlendMode = SE_BLEND_Translucent;
                    Canvas->DrawItem(Body);
                    // A thin brighter band right on the front: the flood's own leading
                    // edge, so the moving boundary still has something to read now that
                    // the straight blade is gone. Only where the field actually cuts —
                    // once the county is fully flooded the lip disappears with it.
                    if (Right < Active[I + 1].X - .5)
                    {
                        const double Cut = FMath::Max(Left, Right - LipWidth);
                        FCanvasTileItem Lip(FVector2D(Cut, Row * Band), FVector2D(Right - Cut, Height), WetLip);
                        Lip.BlendMode = SE_BLEND_Translucent;
                        Canvas->DrawItem(Lip);
                    }
                    if (Left > Active[I].X + .5)
                    {
                        const double Cut = FMath::Min(Right, Left + LipWidth);
                        FCanvasTileItem Lip(FVector2D(Left, Row * Band), FVector2D(Cut - Left, Height), WetLip);
                        Lip.BlendMode = SE_BLEND_Translucent;
                        Canvas->DrawItem(Lip);
                    }
                }
            }
            for (auto &Span : Active)
                Span.X += Span.Step;
        }
    }
    if (ContextAlpha > .01 && Focus < .05 && Map->Fills.Num())
    {
        TArray<FCanvasUVTri> TownTriangles;
        for (const auto &Fill : Map->Fills)
        {
            if (!Fill.Parent)
                continue;
            TArray<FVector2D> Points;
            TArray<bool> Valid;
            for (const auto &Vertex : Fill.Vertices)
            {
                FVector2D Pixel;
                Valid.Add(ToScreen(Vertex, Pixel));
                Points.Add(Pixel);
            }
            for (int I = 0; I + 2 < Fill.Indices.Num(); I += 3)
            {
                const int A = Fill.Indices[I], B = Fill.Indices[I + 1], C = Fill.Indices[I + 2];
                if (!Valid[A] || !Valid[B] || !Valid[C])
                    continue;
                FCanvasUVTri Triangle;
                Triangle.V0_Pos = Points[A];
                Triangle.V1_Pos = Points[B];
                Triangle.V2_Pos = Points[C];
                Triangle.V0_UV = Triangle.V1_UV = Triangle.V2_UV = FVector2D::ZeroVector;
                Triangle.V0_Color = Triangle.V1_Color = Triangle.V2_Color = FLinearColor::White;
                TownTriangles.Add(Triangle);
            }
        }
        if (TownTriangles.Num())
        {
            // The town is not part of the wipe: it is what the county is erased back
            // down to, so it keeps its tint for the whole county phase.
            const FLinearColor Tint(.12, .55, .14, .45 * ContextAlpha);
            for (auto &Triangle : TownTriangles)
                Triangle.V0_Color = Triangle.V1_Color = Triangle.V2_Color = Tint;
            FCanvasTriangleItem Fill(TownTriangles, GWhiteTexture);
            Fill.BlendMode = SE_BLEND_Translucent;
            Canvas->DrawItem(Fill);
        }
    }
    if (FocusTriangles.Num())
    {
        // Saturated green, like the reference reel: the region reads as filled land,
        // not as a translucent blue selection.
        const FLinearColor Tint = FocusId.IsEmpty() ? FLinearColor(.18, .60, .18, .45 * Focus)
                                                    : FLinearColor(.20, .62, .20, .55 * Focus);
        for (auto &Triangle : FocusTriangles)
            Triangle.V0_Color = Triangle.V1_Color = Triangle.V2_Color = Tint;
        FCanvasTriangleItem Fill(FocusTriangles, GWhiteTexture);
        Fill.BlendMode = SE_BLEND_Translucent;
        Canvas->DrawItem(Fill);
    }
    for (const auto &Painted : VisitedFills)
    {
        FCanvasTriangleItem Fill(Painted.Triangles, GWhiteTexture);
        Fill.BlendMode = SE_BLEND_Translucent;
        Canvas->DrawItem(Fill);
    }
    const FLinearColor TownEdge(.031, .070, .026), VillageEdge(.070, .480, .540);
    const FLinearColor ContextEdge(.35, .43, .41), DarkEdge(.009, .018, .021);
    TArray<FCanvasUVTri> BoundaryTriangles;
    // The beam is lifted out of the rim batch. Both used to share one triangle array, and
    // the village rim's 13 px halo plus its 3 px core swallowed the 4.2 px golden trail
    // whole — the triangles were built (the log counted them) and never seen. Drawn as a
    // second item it is guaranteed to sit on top of the white rim.
    TArray<FCanvasUVTri> BeamTriangles;
    const auto AddStrokeTo = [](TArray<FCanvasUVTri> &Into, const FVector2D &A, const FVector2D &B, double Width,
                                const FLinearColor &ColorA, const FLinearColor &ColorB) {
        const FVector2D Direction = (B - A).GetSafeNormal();
        if (Direction.IsNearlyZero())
            return;
        const FVector2D Offset = FVector2D(-Direction.Y, Direction.X) * (Width * .5);
        FCanvasUVTri Triangle;
        Triangle.V0_Pos = A - Offset;
        Triangle.V1_Pos = A + Offset;
        Triangle.V2_Pos = B + Offset;
        Triangle.V0_UV = Triangle.V1_UV = Triangle.V2_UV = FVector2D::ZeroVector;
        Triangle.V0_Color = Triangle.V1_Color = ColorA;
        Triangle.V2_Color = ColorB;
        Into.Add(Triangle);
        Triangle.V1_Pos = Triangle.V2_Pos;
        Triangle.V2_Pos = B - Offset;
        Triangle.V1_Color = ColorB;
        Into.Add(Triangle);
    };
    const auto AddStroke = [&BoundaryTriangles, &AddStrokeTo](const FVector2D &A, const FVector2D &B, double Width,
                                                              const FLinearColor &ColorA, const FLinearColor &ColorB) {
        AddStrokeTo(BoundaryTriangles, A, B, Width, ColorA, ColorB);
    };
    const auto AddBeamStroke = [&BeamTriangles, &AddStrokeTo](const FVector2D &A, const FVector2D &B, double Width,
                                                              const FLinearColor &ColorA, const FLinearColor &ColorB) {
        AddStrokeTo(BeamTriangles, A, B, Width, ColorA, ColorB);
    };
    if (CountyFramed && ContextAlpha > .01 && Wipe > .0005)
    {
        // The rim arrives with the flood: only the part already reached is stroked, and
        // the segment that crosses the front is cut by bisection so the line never runs
        // ahead of the fill. The crest now follows the distance field instead of a
        // straight blade, which is what makes the leading edge read as a moving wet
        // boundary rather than a scanning bar.
        const FLinearColor ParentLine(.36, .70, .96), CrestLine(.62, .92, 1);
        for (const auto &Ring : CountyScreen)
        {
            for (int I = 0; I + 1 < Ring.Num(); I++)
            {
                FVector2D A = Ring[I], B = Ring[I + 1];
                if ((A.X < -100 && B.X < -100) || (A.X > Size.X + 100 && B.X > Size.X + 100) ||
                    (A.Y < -100 && B.Y < -100) || (A.Y > Size.Y + 100 && B.Y > Size.Y + 100))
                    continue;
                const bool NearA = Reached(A), NearB = Reached(B);
                if (!NearA && !NearB)
                    continue;
                if (!NearA)
                    A = CutAtFront(B, A);
                else if (!NearB)
                    B = CutAtFront(A, B);
                if (FVector2D::Distance(A, B) < .25)
                    continue;
                const FVector2D Middle = (A + B) * .5;
                const double Crest = FMath::Clamp(
                    1. - FMath::Abs(FVector2D::Distance(Middle, Seed) - FrontAt(Middle)) / (42. * Scale), 0., 1.);
                const FLinearColor Line = ParentLine + (CrestLine - ParentLine) * float(Crest);
                // Keep the county rim at the same hairline weight as the town outline
                // (pre-4fcd4ef look). A wide dark underlay read as a grey wall.
                AddStroke(A, B, 1.6 * Scale, FLinearColor(Line.R, Line.G, Line.B, .78 * ContextAlpha),
                          FLinearColor(Line.R, Line.G, Line.B, .78 * ContextAlpha));
            }
        }
    }
    for (const auto &Stroke : Strokes)
    {
        if (!Stroke.Parent)
        {
            // The village being toured carries the thick white rim of the reference reel:
            // a soft halo plus a solid core, so the boundary reads even over bright imagery.
            // A village whose shot is over keeps that exact rim — nothing fades out, the
            // accumulated state is the point. Only the village the camera is flying to
            // ramps its rim in; every other one was already lit and stays lit.
            const float A = Stroke.Touring ? float(FMath::Clamp(Stroke.Accent, 0., 1.)) : 1.f;
            if (A < .02)
                continue;
            const FLinearColor Rim(.93, 1., .90);
            AddStroke(Stroke.A, Stroke.B, 13. * Scale, Rim.CopyWithNewOpacity(.12 * A), Rim.CopyWithNewOpacity(.12 * A));
            AddStroke(Stroke.A, Stroke.B, 6.5 * Scale, Rim.CopyWithNewOpacity(.32 * A), Rim.CopyWithNewOpacity(.32 * A));
            AddStroke(Stroke.A, Stroke.B, 3.0 * Scale, Rim.CopyWithNewOpacity(.96 * A), Rim.CopyWithNewOpacity(.96 * A));
            continue;
        }
        // While the county flood layer is up it already outlines the county rim;
        // stroking the same rim again doubled it into a heavy band.
        if (ContextAlpha > .01 && ContextReveal > .0005 && Map->ContextRings.Num())
            continue;
        if (Stroke.Parent && Stroke.Start >= Reveal)
            continue;
        const FVector2D End = Stroke.Parent && Stroke.End > Reveal
            ? FMath::Lerp(Stroke.A, Stroke.B, (Reveal - Stroke.Start) / (Stroke.End - Stroke.Start))
            : Stroke.B;
        const FLinearColor Edge = Stroke.Parent ? TownEdge : VillageEdge;
        const FLinearColor Context = Stroke.Parent ? ContextEdge.CopyWithNewOpacity(.53f) : VillageEdge.CopyWithNewOpacity(.48f);
        FLinearColor Color = FMath::Lerp(Context, Edge.CopyWithNewOpacity(.78f), float(Stroke.Accent));
        if (!Stroke.Parent)
            Color.A *= ChildReveal;
        // Everything below is a parent stroke, and the town outline only belongs to the
        // town's own shots. Its accent dies the moment the tour drops into a village, but
        // the hairline kept its 53–78% grey and went on drawing the town boundary across
        // open water long after the town had left the frame — that stray thread is the
        // faint line over the bay. Riding the accent takes it away with the shot and
        // brings it back for the closing overview.
        if (Stroke.Parent)
            Color.A *= FMath::Clamp(float(Stroke.Accent) * 1.15f, 0.f, 1.f);
        // Single hairline, no dark underlay: the raised 3D rim already frames the town.
        const double BaseWidth = FMath::Lerp(1.2f, 1.7f, float(Stroke.Accent)) * Scale;
        AddStroke(Stroke.A, End, BaseWidth, Color, Color);
    }
    const double Head = N(Trace, TEXT("progress")), TraceAlpha = N(Trace, TEXT("alpha"));
    // The comet that traces the rim. A 6% tail on a village outline disappears into the
    // little zig-zags of a real boundary, so the tail is a sixth of the perimeter and the
    // head carries its own glow.
    constexpr double TraceTail = .16;
    if (TraceAlpha > .01)
        for (int Pass = 0; Pass < 3; ++Pass)
            for (const auto &Stroke : Strokes)
            {
                if (!Stroke.Trace)
                    continue;
                const double Start = FMath::Max(Head - TraceTail, Stroke.Start), End = FMath::Min(Head, Stroke.End);
                if (End <= Start)
                    continue;
                const double Span = Stroke.End - Stroke.Start;
                const FVector2D A = FMath::Lerp(Stroke.A, Stroke.B, (Start - Stroke.Start) / Span);
                const FVector2D B = FMath::Lerp(Stroke.A, Stroke.B, (End - Stroke.Start) / Span);
                const FLinearColor Trail(1, .82, .22);
                if (Pass == 2)
                {
                    // The head itself, so the eye catches the front of the sweep.
                    if (Head - End > .022)
                        continue;
                    AddBeamStroke(A, B, 9. * Scale, Trail.CopyWithNewOpacity(.45 * TraceAlpha),
                                  Trail.CopyWithNewOpacity(.95 * TraceAlpha));
                    continue;
                }
                // A comet whose tail decays linearly is invisible for most of its length:
                // two thirds of it sits under 30% and the white rim simply eats it. The
                // tail now keeps most of its strength and only the very end thins out.
                const double Opacity = TraceAlpha * (Pass == 0 ? .30 : 1.);
                const double FadeStart = FMath::Pow(FMath::Clamp(1. - (Head - Start) / TraceTail, 0., 1.), .45);
                const double FadeEnd = FMath::Pow(FMath::Clamp(1. - (Head - End) / TraceTail, 0., 1.), .45);
                AddBeamStroke(A, B, (Pass == 0 ? 13. : 5.4) * Scale, Trail.CopyWithNewOpacity(FadeStart * Opacity),
                              Trail.CopyWithNewOpacity(FadeEnd * Opacity));
            }
    if (BoundaryTriangles.Num())
    {
        FCanvasTriangleItem Lines(BoundaryTriangles, GWhiteTexture);
        Lines.BlendMode = SE_BLEND_Translucent;
        Canvas->DrawItem(Lines);
    }
    if (BeamTriangles.Num())
    {
        FCanvasTriangleItem Beam(BeamTriangles, GWhiteTexture);
        Beam.BlendMode = SE_BLEND_Translucent;
        Canvas->DrawItem(Beam);
    }
    // The name rides the flood instead of riding its last 18%: while it was tied to
    // SmoothStep(.82, 1., ...) it only reached full opacity at the very end of the grow and
    // was already fading during the erase, so on a 50 s film it never got a readable
    // moment — which is why the county name read as "too small" on screen.
    const double ContextLabelAlpha = ContextAlpha * FMath::SmoothStep(.45, .85, ContextReveal) * LabelsReveal;
    if (FPlatformMisc::GetEnvironmentVariable(TEXT("GEO_LABEL_METRICS")).Len())
    {
        static int32 AlphaReports = 0;
        if (++AlphaReports % 45 == 0)
            UE_LOG(LogTemp, Display, TEXT("GEO_LABEL alpha=%.3f ctxAlpha=%.3f reveal=%.2f camH=%.0f span=%.0f name=%s font=%d"),
                   ContextLabelAlpha, ContextAlpha, ContextReveal, CameraHeight, ContextSpanMeters,
                   *Map->ContextLabel.Name, LabelFont ? 1 : 0);
    }
    // ---- parent name ----------------------------------------------------------
    // The county name is anchored to the county seat, and the seat is not always a free
    // spot: 雷州市's seat sits a couple of kilometres from 龙门镇's northern rim, so at
    // the county framing the parent name landed right on the child's boundary and the
    // two read as one word — while the old "fit inside the township" rule shrank it to
    // about 16 px trying to squeeze under that boundary. It now leaves the township
    // along its nearest side and sits in the county's own band between the two outlines:
    // parent outside, child inside, no overlap, and the type is large enough to read.
    FVector2D ContextPoint = FVector2D::ZeroVector;
    FBox2D ContextBox(FVector2D::ZeroVector, FVector2D::ZeroVector);
    float ContextTextScale = 0;
    int32 ContextPlacement = 0;
    bool bContextName = false;
    if (ContextLabelAlpha > .05 && LabelFont && !Map->ContextLabel.Name.IsEmpty())
    {
        FVector2D Seat;
        if (ToScreen(Map->ContextLabel.Position, Seat))
        {
            float NameW, NameH;
            Canvas->StrLen(LabelFont, Map->ContextLabel.Name, NameW, NameH);
            // 42 px was sized for a desk and then clamped further by the inscribed-circle
            // rule; this is the only text on the county framing, so it gets a section
            // title weight and a width cap instead of the clamp.
            ContextTextScale = 52 * Scale / FMath::Max(1.f, NameH);
            ContextTextScale = FMath::Min(ContextTextScale, Size.X * .30f / FMath::Max(1.f, NameW));
            FVector2D Half(NameW * ContextTextScale * .5f, NameH * ContextTextScale * .5f);
            const FVector2D Gap = FVector2D(10, 8) * Scale;

            // Coarse screen polygon of the township, sampled from the parent rings. A few hundred points are enough to answer "which side is this box
            // on"; projecting all twenty thousand again would cost more than the rest of
            // the HUD put together.
            TArray<TArray<FVector2D>> TownScreen;
            for (const auto &Ring : Map->Rings)
            {
                if (!Ring.Parent || Ring.Points.Num() < 4)
                    continue;
                const int32 Stride = FMath::Max(1, Ring.Points.Num() / 320);
                TArray<FVector2D> Coarse;
                for (int32 I = 0; I < Ring.Points.Num(); I += Stride)
                {
                    FVector2D Pixel;
                    if (ToScreen(Ring.Points[I], Pixel))
                        Coarse.Add(Pixel);
                }
                if (Coarse.Num() >= 3)
                    TownScreen.Add(MoveTemp(Coarse));
            }
            // Decimated county rings: enough for point-in-shape, cheap enough to run a
            // handful of times per frame.
            TArray<TArray<FVector2D>> CountyCoarse;
            for (const auto &Ring : CountyScreen)
            {
                const int32 Stride = FMath::Max(1, Ring.Num() / 360);
                TArray<FVector2D> Coarse;
                for (int32 I = 0; I < Ring.Num(); I += Stride)
                    Coarse.Add(Ring[I]);
                if (Coarse.Num() >= 3)
                    CountyCoarse.Add(MoveTemp(Coarse));
            }
            const auto RingHas = [](const TArray<FVector2D> &Ring, const FVector2D &Pixel) {
                bool Inside = false;
                for (int32 I = 0, J = Ring.Num() - 1; I < Ring.Num(); J = I++)
                    if (((Ring[I].Y > Pixel.Y) != (Ring[J].Y > Pixel.Y)) &&
                        Pixel.X < (Ring[J].X - Ring[I].X) * (Pixel.Y - Ring[I].Y) / (Ring[J].Y - Ring[I].Y) + Ring[I].X)
                        Inside = !Inside;
                return Inside;
            };
            const auto InCounty = [&](const FVector2D &Pixel) {
                for (const auto &Ring : CountyCoarse)
                    if (RingHas(Ring, Pixel))
                        return true;
                return false;
            };
            const double BandY = .75 * Size.Y;
            const FBox2D Caption(FVector2D(.08 * Size.X, BandY - 56 * Scale),
                                 FVector2D(.92 * Size.X, BandY + 56 * Scale));
            const FBox2D Safe(FVector2D(20, 20) * Scale, FVector2D(Size.X, Size.Y) - FVector2D(20, 20) * Scale);
            // Distance from the township outline, not from its screen box: the box is a
            // superset and the seat of 雷州市 pokes out of the northern rim, so a bbox
            // test would call that spot free while the name still sat on the line. The
            // gap is enforced on the expanded box so the name keeps a breath of air.
            const auto ClearsTown = [&](const FBox2D &Box) {
                for (int32 Row = 0; Row < 3; ++Row)
                    for (int32 Col = 0; Col < 4; ++Col)
                    {
                        const FVector2D Sample(FMath::Lerp(Box.Min.X, Box.Max.X, Col / 3.),
                                               FMath::Lerp(Box.Min.Y, Box.Max.Y, Row / 2.));
                        for (const auto &Ring : TownScreen)
                            if (RingHas(Ring, Sample))
                                return false;
                    }
                return true;
            };
            const auto Fits = [&](const FVector2D &At) {
                const FBox2D Box(At - Half, At + Half);
                if (!Safe.IsInside(Box))
                    return 1;
                if (Caption.Intersect(Box))
                    return 2;
                // Only a hairline of tolerance here: the exits below already step a whole
                // Gap clear of the outline, and expanding again by Gap would make the two
                // rules cancel out and reject the very spot they just chose.
                if (!ClearsTown(Box.ExpandBy(1.5 * Scale)))
                    return 3;
                // The name has to stay on the county: centre plus corners, so a box that
                // straddles the rim into open water is rejected too.
                int32 Inside = InCounty(At) ? 1 : 0;
                for (const FVector2D &Corner : {FVector2D(Box.Min.X, Box.Min.Y), FVector2D(Box.Max.X, Box.Min.Y),
                                                FVector2D(Box.Min.X, Box.Max.Y), FVector2D(Box.Max.X, Box.Max.Y)})
                    Inside += InCounty(Corner) ? 1 : 0;
                return Inside >= 3 ? 0 : 4;
            };
            TArray<FVector2D> Candidates{Seat};
            // The exits follow the outline across the whole band the name will occupy, not
            // just the line through the seat: a 3-character name is 80 px wide, and a
            // township rim that climbs 10 px inside that span still ends up under the text.
            // `Envelope` is the nearest outline coordinate in that band.
            const auto Envelope = [&](bool VerticalExtent, bool TowardsNegative) {
                // VerticalExtent: sweep the horizontal band the text will occupy (its X
                // span) and report the outline's nearest Y. Otherwise sweep the vertical
                // band and report its nearest X.
                const double Center = VerticalExtent ? Seat.X : Seat.Y;
                const double Span = VerticalExtent ? Half.X + Gap.X : Half.Y + Gap.Y;
                double Best = TowardsNegative ? 1e9 : -1e9;
                bool Found = false;
                for (const auto &Ring : TownScreen)
                    for (const FVector2D &P : Ring)
                    {
                        const double Along = VerticalExtent ? P.X : P.Y;
                        const double Across = VerticalExtent ? P.Y : P.X;
                        if (FMath::Abs(Along - Center) > Span)
                            continue;
                        if (!Found || (TowardsNegative ? Across < Best : Across > Best))
                        {
                            Best = Across;
                            Found = true;
                        }
                    }
                return Found ? Best : (TowardsNegative ? -1e9 : 1e9);
            };
            if (TownScreen.Num())
            {
                Candidates.Add(FVector2D(Seat.X, Envelope(true, true) - Half.Y - Gap.Y));   // above
                Candidates.Add(FVector2D(Seat.X, Envelope(true, false) + Half.Y + Gap.Y));  // below
                Candidates.Add(FVector2D(Envelope(false, true) - Half.X - Gap.X, Seat.Y));  // left
                Candidates.Add(FVector2D(Envelope(false, false) + Half.X + Gap.X, Seat.Y)); // right
            }
            Candidates.Sort([&Seat](const FVector2D &A, const FVector2D &B) {
                return FVector2D::Distance(A, Seat) < FVector2D::Distance(B, Seat);
            });
            // Shortest move wins, so the name stays where the reader expects it; the
            // previous choice is kept while it is still valid, so the solver does not
            // hop between sides as the camera creeps.
            const int32 *Previous = LabelPlacements.Find(TEXT("@parent"));
            int32 Chosen = INDEX_NONE;
            if (Previous && *Previous >= 0 && *Previous < Candidates.Num() && Fits(Candidates[*Previous]) == 0)
                Chosen = *Previous;
            for (int32 I = 0; Chosen == INDEX_NONE && I < Candidates.Num(); ++I)
                if (Fits(Candidates[I]) == 0)
                    Chosen = I;
            if (FPlatformMisc::GetEnvironmentVariable(TEXT("GEO_LABEL_METRICS")).Len())
            {
                static int32 RejectReports = 0;
                if (Chosen == INDEX_NONE && ++RejectReports % 45 == 0)
                {
                    FString Why;
                    for (int32 I = 0; I < Candidates.Num(); ++I)
                        Why += FString::Printf(TEXT("%.0f,%.0f:r%d "), Candidates[I].X, Candidates[I].Y, Fits(Candidates[I]));
                    UE_LOG(LogTemp, Display, TEXT("GEO_LABEL ctx rejected seat=%.0f,%.0f rings=%d -> %s"),
                           Seat.X, Seat.Y, TownScreen.Num(), *Why);
                }
            }
            if (Chosen != INDEX_NONE)
            {
                ContextPoint = Candidates[Chosen];
                ContextPlacement = Chosen;
            }
            else if (TownScreen.Num())
            {
                // No exit works — a village shot, or a county whose band is off screen.
                // Fall back to the seat, fitted inside the township the way it used to
                // be, but with a floor that is still readable.
                double Room = 0;
                for (const auto &Ring : TownScreen)
                    for (const FVector2D &Vertex : Ring)
                        Room = Room <= 0 ? double(FVector2D::Distance(Seat, Vertex))
                                         : FMath::Min(Room, double(FVector2D::Distance(Seat, Vertex)));
                if (Room > 4)
                {
                    const float Diagonal = FMath::Sqrt(FMath::Square(Half.X * 2.f) + FMath::Square(Half.Y * 2.f));
                    ContextTextScale = FMath::Min(ContextTextScale, float(2. * Room / FMath::Max(1.f, Diagonal)));
                    ContextTextScale = FMath::Max(ContextTextScale, 22.f / FMath::Max(1.f, NameH));
                }
                ContextPoint = Seat;
            }
            else
            {
                ContextPoint = Seat;
            }
            if (FPlatformMisc::GetEnvironmentVariable(TEXT("GEO_LABEL_METRICS")).Len())
            {
                static int32 ContextReports = 0;
                if (++ContextReports % 45 == 0)
                    UE_LOG(LogTemp, Display, TEXT("GEO_LABEL ctx=%s W=%.1f H=%.1f scale=%.3f glyph=%.1f at=%.0f,%.0f seat=%.0f,%.0f pick=%d"),
                           *Map->ContextLabel.Name, NameW, NameH, ContextTextScale, NameH * ContextTextScale,
                           ContextPoint.X, ContextPoint.Y, Seat.X, Seat.Y, ContextPlacement);
            }
            Half = FVector2D(NameW * ContextTextScale * .5f, NameH * ContextTextScale * .5f);
            ContextBox = FBox2D(ContextPoint - Half, ContextPoint + Half).ExpandBy(2 * Scale);
            bContextName = true;
        }
    }
    if (bContextName)
    {
        const FLinearColor ContextColor(.72, .90, 1, .85 * ContextLabelAlpha);
        FCanvasTextItem Text(ContextPoint, FText::FromString(Map->ContextLabel.Name), LabelFont, ContextColor);
        Text.bCentreX = true;
        Text.bCentreY = true;
        Text.Scale = FVector2D(ContextTextScale);
        const FLinearColor Outline = DarkEdge.CopyWithNewOpacity(.90 * ContextLabelAlpha);
        Text.SetColor(Outline);
        const double Halo = FMath::Max(1.5, 2.2 * Scale);
        for (const FVector2D Offset : {FVector2D(-Halo, 0), FVector2D(Halo, 0), FVector2D(0, -Halo), FVector2D(0, Halo)})
            Canvas->DrawItem(Text, ContextPoint + Offset);
        Text.SetColor(ContextColor);
        Canvas->DrawItem(Text);
    }
    struct FLabelDraw
    {
        FString Id, Name, PlatePath;
        FVector2D Anchor, Extent;
        FLinearColor Color;
        float TextScale, Emphasis, IconSize, PlateHeight;
        UTexture2D *PlateTexture = nullptr;
        int32 Priority;
        // The town name is laid out by hand: characters, tracking between them, and the
        // float that keeps it moving. Villages still draw as one string.
        int32 CharCount = 0;
        float Tracking = 0, UnitWidth = 0;
        bool Animated = false;
    };
    TArray<FLabelDraw> DrawLabels;
    if (!LabelFont)
    {
        LabelFont = DuplicateObject<UFont>(GEngine->GetLargeFont(), this);
#if PLATFORM_WINDOWS
        // Use the bold face Chromium resolves for the Cesium labels on this Windows setup.
        const FString WindowsDir = FPlatformMisc::GetEnvironmentVariable(TEXT("WINDIR"));
        const FString FontPath = FPaths::Combine(WindowsDir, TEXT("Fonts/msyhbd.ttc"));
        if (!WindowsDir.IsEmpty() && FPaths::FileExists(FontPath))
        {
            auto &Composite = LabelFont->GetMutableInternalCompositeFont();
            if (const auto *DefaultFont = LabelFont->GetCompositeFont(); DefaultFont && DefaultFont != &Composite)
                Composite.FallbackTypeface = DefaultFont->FallbackTypeface;
            Composite.DefaultTypeface.Fonts.Reset();
            Composite.DefaultTypeface.AppendFont(TEXT("Bold"), FontPath, EFontHinting::Default, EFontLoadingPolicy::LazyLoad);
            LabelFont->FontCacheType = EFontCacheType::Runtime;
            LabelFont->RuntimeFontSource = ERuntimeFontSource::Asset;
            LabelFont->LegacyFontName = TEXT("Bold");
        }
#endif
        // Rasterize Chinese glyphs near their display size instead of
        // enlarging the low-resolution legacy Canvas glyph atlas.
        if (LabelFont->FontCacheType == EFontCacheType::Runtime)
            LabelFont->LegacyFontSize = 64;
    }
    if (!LabelPin)
        LabelPin = LoadCloudTexture(FPaths::Combine(FPaths::ProjectContentDir(), TEXT("Geo/label-pin.png")));
    float GlyphWidth, GlyphHeight;
    Canvas->StrLen(LabelFont, TEXT("国"), GlyphWidth, GlyphHeight);
    const double Reference = FMath::Max(1., N(F, TEXT("labelReferenceDistance"), 38000));
    const FVector Eye = Map->Camera->GetComponentLocation();
    // Room around a point inside the town, in pixels: the distance to the nearest point of
    // the town outline. Only the parent name needs it, and only while it is on screen.
    const auto TownRoom = [this, Map, &ToScreen](const FVector2D &Center) {
        double Room = 0;
        for (const auto &Ring : Map->Rings)
        {
            if (!Ring.Parent)
                continue;
            for (const FVector &Vertex : Ring.Points)
            {
                FVector2D Pixel;
                if (!ToScreen(Vertex, Pixel))
                    continue;
                const double Distance = FVector2D::Distance(Center, Pixel);
                Room = Room <= 0 ? Distance : FMath::Min(Room, Distance);
            }
        }
        return Room;
    };
    for (const auto &Label : Map->Labels)
    {
        const TSharedPtr<FJsonObject> *Style = nullptr;
        if (!Label.Parent && !Styles->TryGetObjectField(Label.Id, Style))
            continue;
        const double Alpha = Label.Parent ? N(F, TEXT("parentLabel")) : N(*Style, TEXT("alpha"));
        if (Alpha <= .01 || Label.Name.IsEmpty())
            continue;
        FVector2D Point;
        if (!ToScreen(Label.Position, Point))
            continue;
        if (Point.X < 0 || Point.X > Size.X || Point.Y < 0 || Point.Y > Size.Y)
            continue;

        // The shader's NearFarScalar uses squared eye distance and a fifth-root ease.
        const double DistanceRatioSq = FVector::DistSquared(Eye, Label.Position) / FMath::Square(Reference * 100);
        const auto Ramp = [DistanceRatioSq](double Near, double Far) {
            return FMath::Pow(FMath::Clamp((DistanceRatioSq - Near * Near) / (Far * Far - Near * Near), 0., 1.), .2);
        };
        const bool CurrentVillage = !Label.Parent && Label.Id == Current;
        const bool Primary = Label.Parent || CurrentVillage;
        const float Opacity = float(Alpha * LabelsReveal * (1 - Ramp(1, 2.8) * (Primary ? .40 : 1.)));
        if (Opacity <= .01)
            continue;
        const float Emphasis = Label.Parent ? 0 : N(*Style, TEXT("emphasis"));
        // The township name is drawn at twice the size it used to be: at the wide framing
        // the town is a shape on a satellite photo and the name was reading as a caption
        // rather than as the title of the shot.
        //
        // Doubling the nominal size alone would do nothing there. Measured on the 龙门镇
        // overview: sizePx 112.9 but final scale 0.607, i.e. 68 px of glyph — the size is
        // capped by the inscribed circle at the label point, not by SizePx. So all three
        // knobs move together: nominal size, the circle the name may occupy, and the floor
        // that keeps it readable when fitting would otherwise shrink it to a smear.
        constexpr float TownNameScale = 2.f;
        // A village that has already had its shot keeps the size it had in the Cesium build
        // (CHILD_LABEL_FONT_SIZE = 56): there, every child name was one size, emphasis and
        // all. Here the name that is still being toured is carried by its plaque, so it is
        // the *retired* ones that needed the old body size — at 52.5 x 0.82 they were
        // reading as faint specks next to the village currently on screen. The distance
        // falloff stays (Cesium had scaleByDistance too); 64 x .88 lands back on 56.
        constexpr float RestVillagePx = 64.f;
        const float VillagePx = CurrentVillage ? FMath::Lerp(52.5f, 64.f, Emphasis) * 1.06f : RestVillagePx;
        const float SizePx = (Label.Parent ? 120.f * TownNameScale : VillagePx)
                             * Scale * FMath::Lerp(1.f, Primary ? .90f : .88f, Ramp(.5, 3));
        float Width, Height;
        Canvas->StrLen(LabelFont, Label.Name, Width, Height);
        // The town name is drawn one character at a time with half a glyph of tracking in
        // between — about one Latin character. The HUD knows the exact advance that way, so
        // the on-screen width is known before placement and can be fitted to the shape.
        // Tracking is the gap between two characters. The total is that times the number of
        // gaps, and only the total belongs in width maths — the draw loop adds Tracking once
        // per character. Adding the total there (as an earlier version did) opened each gap
        // by (CharCount - 1) halves, so a three-character name read as 迈 陈 镇 with a whole
        // Chinese character of air in it instead of a Latin one.
        const int32 CharCount = Label.Parent ? Label.Name.Len() : 0;
        const float Tracking = CharCount > 1 ? GlyphHeight * .5f : 0.f;
        const float TrackingTotal = Tracking * FMath::Max(0, CharCount - 1);
        float TextScale = FMath::Min(SizePx / FMath::Max(1.f, GlyphHeight), Size.X * .80f / FMath::Max(1.f, Width + TrackingTotal));
        if (Label.Parent)
        {
            // A name that spills over the boundary is worse than a small name — and the
            // county shot zooms out until the town is a thumbnail. Everything scales
            // linearly, so the largest box that still fits is the one whose half-diagonal
            // fits the circle inscribed at the label point.
            // Room is a radius, so doubling it lets the name take twice the circle. This is
            // the knob that actually decides the on-screen size on the wide shots; the
            // nominal size above only binds once the town fills more of the frame.
            const double Room = TownRoom(Point) * TownNameScale;
            if (Room > 4)
            {
                const float Diagonal = FMath::Sqrt(FMath::Square(Width + TrackingTotal) + FMath::Square(Height));
                TextScale = FMath::Min(TextScale, float(2. * Room / FMath::Max(1.f, Diagonal)));
                // A floor: honouring the boundary at county zoom would make the name
                // unreadable. Below this it is allowed to spill rather than disappear.
                // Floor raised from 16 px: at the county framing the township is a
                // thumbnail, and 16 px on a phone is a smear.
                // It deliberately does NOT follow TownNameScale. At the county framing the
                // township is a thumbnail and the name has to stay subordinate to the
                // county name (52 px): a doubled floor put it at 48 px, i.e. the same size
                // as 雷州市, which flattened the hierarchy. Doubling the circle above is
                // already enough to lift this shot from 24 px to ~42 px.
                TextScale = FMath::Max(TextScale, 24.f / FMath::Max(1.f, GlyphHeight));
                if (FPlatformMisc::GetEnvironmentVariable(TEXT("GEO_LABEL_METRICS")).Len())
                {
                    static int32 TownReports = 0;
                    if (++TownReports % 45 == 0)
                        UE_LOG(LogTemp, Display, TEXT("GEO_LABEL town=%s sizePx=%.1f glyphH=%.1f glyphW=%.1f room=%.1f finalScale=%.3f glyph=%.1f"),
                               *Label.Name, SizePx, GlyphHeight, GlyphWidth, Room, TextScale, GlyphHeight * TextScale);
                }
            }
        }
        // A village that has already been toured. Cesium painted these white and
        // outlined them in black at any distance; a grey body under a black rim reads
        // as a hole in the map rather than a label, so the body goes white here too.
        const bool RetiredVillage = !Label.Parent && !CurrentVillage;
        FVector2D Extent = FVector2D(Label.Parent ? Width + TrackingTotal : Width, Height) * TextScale * .5
                           + (CurrentVillage ? FVector2D(12, 6) : FVector2D(5, 3)) * Scale;
        const FLinearColor Color = (RetiredVillage ? FLinearColor::White
                                                  : FMath::Lerp(FLinearColor(.86, .91, .94), FLinearColor::White,
                                                                Primary ? 1.f : Emphasis))
                                       .CopyWithNewOpacity(Opacity);
        // The town's name is plain text on the map, like the Cesium build: no pin and no
        // plaque. Villages keep the pin because they are the subject of their own shot.
        // 225 = 150 x 1.5. The pin artwork is the cube-over-rings icon
        // (Content/Geo/label-pin.png, 512 px, same 75 %-of-canvas framing as before), so
        // the on-screen artwork grows by exactly the same factor as this number.
        // GEO_PIN_PROBE draws the pin at the township as well, because the preview film
        // only shows the pin during a village shot — this is how the artwork and its
        // on-screen size get checked without waiting for the tour.
        const bool PinProbe = !FPlatformMisc::GetEnvironmentVariable(TEXT("GEO_PIN_PROBE")).IsEmpty();
        const float IconSize = (CurrentVillage || PinProbe)
            ? 225.f * Scale * FMath::Lerp(1.f, .90f, Ramp(.5, 3))
            : 0.f;
        float PlateHeight = 0;
        UTexture2D *PlateTexture = nullptr;
        if (CurrentVillage && !Label.PlatePath.IsEmpty())
        {
            PlateTexture = LabelPlates.FindRef(Label.PlatePath);
            if (!PlateTexture)
            {
                PlateTexture = LoadCloudTexture(Label.PlatePath);
                if (PlateTexture)
                    LabelPlates.Add(Label.PlatePath, PlateTexture);
            }
            if (PlateTexture)
            {
                PlateHeight = (CurrentVillage ? 138.f : 150.f) * Scale * FMath::Lerp(1.f, .90f, Ramp(.5, 3));
                const float Aspect = float(PlateTexture->GetSizeX()) / FMath::Max(1, PlateTexture->GetSizeY());
                Extent = FVector2D(PlateHeight * Aspect, PlateHeight) * .5;
            }
        }
        DrawLabels.Add({Label.Id, Label.Name, Label.PlatePath, Point, Extent, Color, TextScale, Emphasis,
                        IconSize, PlateHeight, PlateTexture, CurrentVillage ? 2 : Label.Parent ? 1 : 0,
                        CharCount, Tracking * TextScale, (Width + TrackingTotal) * TextScale, Label.Parent});
    }
    DrawLabels.Sort([this](const FLabelDraw &A, const FLabelDraw &B) {
        if (A.Priority != B.Priority)
            return A.Priority > B.Priority;
        if (A.Emphasis != B.Emphasis)
            return A.Emphasis > B.Emphasis;
        const bool WasVisible = LabelPlacements.Contains(A.Id), OtherWasVisible = LabelPlacements.Contains(B.Id);
        if (WasVisible != OtherWasVisible)
            return WasVisible;
        return A.Id < B.Id;
    });
    // Studio and the video compositor center captions 25% above the bottom edge.
    const double CaptionY = .75 * Size.Y;
    TArray<FBox2D> Occupied{FBox2D(FVector2D(.08 * Size.X, CaptionY - 56 * Scale),
                                  FVector2D(.92 * Size.X, CaptionY + 56 * Scale))};
    const FBox2D SafeFrame(FVector2D(20, 20) * Scale, FVector2D(Size.X, Size.Y) - FVector2D(20, 20) * Scale);
    TMap<FString, int32> Placements;
    if (bContextName)
    {
        // Reserve the parent name: a village label drawn on top of it made the county
        // read as the village's name instead of its parent.
        Occupied.Add(ContextBox);
        Placements.Add(TEXT("@parent"), ContextPlacement);
    }
    for (const auto &Label : DrawLabels)
    {
        const bool Pinned = Label.IconSize > 0;
        // Village names grew by half, so the packing has to be tighter — at the old slack
        // the closing overview started dropping four or five names instead of fitting them.
        const double Gap = (Pinned ? 20 : 8) * Scale;
        const double X = Label.Extent.X + Gap, Y = Label.Extent.Y + Gap;
        const double BaseY = Pinned ? -(Label.IconSize + Gap + Label.Extent.Y) : 0;
        TArray<FVector2D> Offsets;
        if (Pinned)
            Offsets = {FVector2D(0, BaseY), FVector2D(0, BaseY - Y), FVector2D(X, BaseY),
                       FVector2D(-X, BaseY), FVector2D(X, BaseY - Y), FVector2D(-X, BaseY - Y),
                       FVector2D(0, BaseY - 2 * Y)};
        else
            // Wider set of candidates: the overview carries a dozen names inside one town,
            // and a name is worth more where it is than not drawn at all.
            Offsets = {{0, 0}, {0, -Y}, {X, 0}, {-X, 0}, {0, Y},
                       {X, -Y}, {-X, -Y}, {X, Y}, {-X, Y},
                       {0, -Y - 40 * Scale}, {0, Y + 40 * Scale},
                       {X * 1.35, 0}, {-X * 1.35, 0}, {0, -2 * Y}, {0, 2 * Y}};
        const int32 OffsetCount = Offsets.Num();
        if (Pinned && LabelPin)
        {
            const float IconSize = Label.IconSize;
            const FVector2D IconMin(Label.Anchor.X - IconSize * .5f, Label.Anchor.Y - IconSize);
            FCanvasTileItem Icon(IconMin, FVector2D(IconSize, IconSize),
                                 FLinearColor(1, 1, 1, FMath::Min(1.f, Label.Color.A * 1.08f)));
            Icon.Texture = LabelPin->GetResource();
            Icon.BlendMode = SE_BLEND_Translucent;
            Canvas->DrawItem(Icon);
            Occupied.Add(FBox2D(FVector2D(Label.Anchor.X - IconSize * .5f, Label.Anchor.Y - IconSize),
                                FVector2D(Label.Anchor.X + IconSize * .5f, Label.Anchor.Y))
                             .ExpandBy(2 * Scale));
        }
        const int32 *PreviousRaw = LabelPlacements.Find(Label.Id);
        const int32 *Previous = PreviousRaw && *PreviousRaw < OffsetCount ? PreviousRaw : nullptr;
        int32 Selected = INDEX_NONE;
        FBox2D Bounds;
        if (Pinned || Label.Animated)
        {
            // The pin and its plaque are one unit: keep the plaque centered directly above
            // the pin and never draw a leader line to it.
            // The town name is pinned to its label point for the same reason it is sized
            // against the outline: any nudge would push it back outside the boundary.
            const FVector2D Point = Label.Anchor + FVector2D(0, BaseY);
            Bounds = FBox2D(Point - Label.Extent, Point + Label.Extent);
            Selected = 0;
        }
        else
        {
            // Reuse a valid placement during motion. The second pass drops the "do not sit
            // on a boundary line" rule: a village name that crosses its own outline reads
            // far better than a village with no name at all.
            for (int32 Pass = 0; Pass < 2 && Selected == INDEX_NONE; ++Pass)
                for (int32 Order = Previous ? -1 : 0; Order < OffsetCount; ++Order)
                {
                    const int32 Candidate = Order < 0 ? *Previous : Order;
                    if (Order >= 0 && Previous && Candidate == *Previous)
                        continue;
                    const FVector2D Point = Label.Anchor + Offsets[Candidate];
                    FBox2D Box(Point - Label.Extent, Point + Label.Extent);
                    // Villages on the edge of the town are only half in frame. Pulling a
                    // candidate back inside is worth more than dropping the name: at the
                    // closing overview those were the names that never showed up.
                    if (!SafeFrame.IsInside(Box) && Box.GetSize().X <= SafeFrame.GetSize().X &&
                        Box.GetSize().Y <= SafeFrame.GetSize().Y)
                    {
                        const FVector2D Span = Box.GetSize();
                        FVector2D Center = Box.GetCenter();
                        Center.X = FMath::Clamp(Center.X, SafeFrame.Min.X + Span.X * .5, SafeFrame.Max.X - Span.X * .5);
                        Center.Y = FMath::Clamp(Center.Y, SafeFrame.Min.Y + Span.Y * .5, SafeFrame.Max.Y - Span.Y * .5);
                        Box = FBox2D(Center - Span * .5, Center + Span * .5);
                    }
                    if (!SafeFrame.IsInside(Box) || Occupied.ContainsByPredicate([&Box](const FBox2D &Other) {
                            return Other.Intersect(Box);
                        }))
                        continue;
                    const FBox EdgeBox(FVector(Box.Min, -1), FVector(Box.Max, 1));
                    if (Pass == 0 && Strokes.ContainsByPredicate([&](const FGeoStroke &Stroke) {
                            if (Stroke.Parent && Stroke.Start >= Reveal)
                                return false;
                            const FVector Start(Stroke.A, 0), End(Stroke.B, 0);
                            return FMath::LineBoxIntersection(EdgeBox, Start, End, End - Start);
                        }))
                        continue;
                    Selected = Candidate;
                    Bounds = Box;
                    break;
                }
            if (Selected == INDEX_NONE)
            {
                // Nothing fit. A name on the map is worth more than a perfect layout, so it
                // goes on its own anchor, pulled back inside the frame — the halo keeps it
                // legible even where it brushes a neighbour.
                FVector2D Center = Label.Anchor;
                const FVector2D Span = Label.Extent * 2;
                if (Span.X <= SafeFrame.GetSize().X && Span.Y <= SafeFrame.GetSize().Y)
                {
                    Center.X = FMath::Clamp(Center.X, SafeFrame.Min.X + Label.Extent.X, SafeFrame.Max.X - Label.Extent.X);
                    Center.Y = FMath::Clamp(Center.Y, SafeFrame.Min.Y + Label.Extent.Y, SafeFrame.Max.Y - Label.Extent.Y);
                }
                Bounds = FBox2D(Center - Label.Extent, Center + Label.Extent);
                Selected = 0;
                if (FPlatformMisc::GetEnvironmentVariable(TEXT("GEO_LABEL_DEBUG")).Len() > 0)
                    UE_LOG(LogTemp, Warning, TEXT("LABEL_FALLBACK %s anchor %.0f,%.0f extent %.0fx%.0f"),
                           *Label.Id, Label.Anchor.X, Label.Anchor.Y, Label.Extent.X, Label.Extent.Y);
            }
        }
        Occupied.Add(Bounds.ExpandBy(2 * Scale));
        Placements.Add(Label.Id, Selected);
        const FVector2D Position = Bounds.GetCenter();
        if (Label.Priority == 2 && Selected != 0 && !Pinned)
        {
            const FVector2D Tip(FMath::Clamp(Label.Anchor.X, Bounds.Min.X, Bounds.Max.X),
                                FMath::Clamp(Label.Anchor.Y, Bounds.Min.Y, Bounds.Max.Y));
            FVector2D LeaderStart = Label.Anchor;
            if (Pinned)
                LeaderStart.Y -= Label.IconSize * .92f;
            FCanvasLineItem Leader(LeaderStart, Tip);
            Leader.BlendMode = SE_BLEND_Translucent;
            Leader.LineThickness = 3.5f * Scale;
            Leader.SetColor(DarkEdge.CopyWithNewOpacity(.82 * Label.Color.A));
            Canvas->DrawItem(Leader);
            Leader.LineThickness = 1.5f * Scale;
            Leader.SetColor((Label.Priority == 2 ? VillageEdge : TownEdge).CopyWithNewOpacity(.90 * Label.Color.A));
            Canvas->DrawItem(Leader);
        }
        if (Label.Priority == 2 && Selected != 0 && !Label.PlateTexture)
        {
            FCanvasTileItem Backdrop(Bounds.Min, Bounds.GetSize(), DarkEdge.CopyWithNewOpacity(.66 * Label.Color.A));
            Backdrop.BlendMode = SE_BLEND_Translucent;
            Canvas->DrawItem(Backdrop);
        }
        if (Label.PlateTexture)
        {
            FCanvasTileItem Plate(Position - Label.Extent, Label.Extent * 2,
                                  FLinearColor(1, 1, 1, FMath::Min(1.f, Label.Color.A * 1.05f)));
            Plate.Texture = Label.PlateTexture->GetResource();
            Plate.BlendMode = SE_BLEND_Translucent;
            Canvas->DrawItem(Plate);
        }
        else
        {
        // The retired village name gets the Cesium outline: pure black, fully opaque, 3.4 px
        // (CHILD_LABEL_OUTLINE / CHILD_LABEL_OUTLINE_WIDTH, alpha = fill * 1.05). The old
        // 1.9 px translucent DarkEdge halo — fine while the name sat under a plaque — left
        // it dissolving into the dimmed imagery once the shot had moved on.
        // Priority 0 is exactly "a village that is neither the subject nor the township".
        const bool RestName = Label.Priority == 0;
        const double Halo = FMath::Max(1.25, (RestName ? 3.4 : Label.Priority ? 2.65 : 1.9) * Scale);
        const FLinearColor Outline = (RestName ? FLinearColor::Black : DarkEdge)
                                         .CopyWithNewOpacity((RestName ? 1.f : .93f) * Label.Color.A);
        const auto DrawGlyph = [&](const FString &Glyph, const FVector2D &At, float GlyphScale) {
            FCanvasTextItem Text(At, FText::FromString(Glyph), LabelFont, Label.Color);
            Text.bCentreX = true;
            Text.bCentreY = true;
            Text.Scale = FVector2D(GlyphScale);
            Text.SetColor(Outline);
            for (const FVector2D Offset : {FVector2D(-Halo, 0), FVector2D(Halo, 0), FVector2D(0, -Halo), FVector2D(0, Halo)})
                Canvas->DrawItem(Text, At + Offset);
            Text.SetColor(Label.Color);
            Text.bOutlined = true;
            Text.OutlineColor = Outline;
            Canvas->DrawItem(Text, At);
        };
        if (Label.Animated)
        {
            // A slow, shallow drift — a twentieth of a glyph — with each character offset
            // in phase from the next. Enough to feel alive, far from busy.
            const double Clock = N(F, TEXT("time"));
            float Cursor = Position.X - Label.UnitWidth * .5f;
            for (int32 Index = 0; Index < Label.CharCount; ++Index)
            {
                const FString Glyph = Label.Name.Mid(Index, 1);
                float GlyphW, GlyphH;
                Canvas->StrLen(LabelFont, Glyph, GlyphW, GlyphH);
                const double Bob = FMath::Sin(Clock * 1.15 + Index * .9) * GlyphH * .05 * Label.TextScale;
                DrawGlyph(Glyph, FVector2D(Cursor + GlyphW * Label.TextScale * .5, Position.Y + Bob), Label.TextScale);
                Cursor += GlyphW * Label.TextScale + Label.Tracking;
            }
        }
        else
            DrawGlyph(Label.Name, Position, Label.TextScale);
        }
    }
    LabelPlacements = MoveTemp(Placements);
    const auto Clouds = O(F, TEXT("clouds"));
    const double Raw = N(Clouds, TEXT("raw"), 1);
    auto CloudLayer = [this](UTexture2D *Texture, double Alpha, double Zoom, double X, double Y) {
        if (!Texture || Alpha < .001)
            return;
        const FVector2D Extent(Canvas->SizeX * Zoom, Canvas->SizeY * Zoom);
        const FVector2D Position((Canvas->SizeX - Extent.X) / 2 + X * Canvas->SizeX / 1080,
                                 (Canvas->SizeY - Extent.Y) / 2 + Y * Canvas->SizeY / 1920);
        FCanvasTileItem Tile(Position, Texture->GetResource(), Extent, FLinearColor(1, 1, 1, Alpha));
        Tile.BlendMode = SE_BLEND_Translucent;
        Canvas->DrawItem(Tile);
    };
    if (!Map->UsesNativeClouds())
    {
        CloudLayer(Map->CloudDeck, N(Clouds, TEXT("deck")), 1.05 + Raw * .16, (Raw - .5) * -28, (Raw - .5) * 20);
        CloudLayer(Map->CloudDeck, N(Clouds, TEXT("volume")) * .18, 1.5 + Raw * .8, (Raw - .5) * 100, (Raw - .5) * -70);
        CloudLayer(Map->CloudPass, N(Clouds, TEXT("veil")), 1.06 + Raw * .13, (Raw - .5) * -31, (Raw - .5) * 17);
    }
    if (Map->ImageryProvider == TEXT("cesium-ion-world-imagery") && !Map->ImageryAttribution.IsEmpty())
    {
        const auto *Font = GEngine->GetLargeFont();
        float Width, Height;
        Canvas->StrLen(Font, Map->ImageryAttribution, Width, Height);
        const float CreditScale = FMath::Min(18 * Scale / FMath::Max(1.f, Height), (Size.X - 24 * Scale) / FMath::Max(1.f, Width));
        FCanvasTextItem Credit(FVector2D(12 * Scale, Size.Y - Height * CreditScale - 9 * Scale),
            FText::FromString(Map->ImageryAttribution), Font, FLinearColor::White);
        Credit.Scale = FVector2D(CreditScale);
        Credit.EnableShadow(FLinearColor::Black, FVector2D(1, 1));
        Canvas->DrawItem(Credit);
    }
}
bool AGeoMap::UsesNativeClouds() const
{
    // A hidden deck must not suppress the canvas overlay either, otherwise cloud shots
    // would fall back to nothing at all.
    return Sky != nullptr && Sky->HasCloudDeck() && Sky->GetDeckOpacity() > .02;
}

AGeoGameMode::AGeoGameMode()
{
    HUDClass = AGeoHUD::StaticClass();
    DefaultPawnClass = nullptr;
}
void AGeoGameMode::StartPlay()
{
    Super::StartPlay();
    GetWorld()->SpawnActor<AGeoMap>();
}
