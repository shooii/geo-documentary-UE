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
    if (auto *Limit = IConsoleManager::Get().FindConsoleVariable(TEXT("t.MaxFPS")))
        Limit->Set(30.f, ECVF_SetByCode);
    if (auto *Rate = IConsoleManager::Get().FindConsoleVariable(TEXT("PixelStreaming2.WebRTC.Fps")))
        Rate->Set(30, ECVF_SetByCode);
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
            // The town's name is set with a full-width space between characters, the way
            // the Cesium build tracked it out. Done here rather than in the HUD so label
            // measuring, collision and the text itself all see the same string.
            const FString Name = S(Region, TEXT("name"));
            FString Spaced;
            for (int32 Index = 0; Index < Name.Len(); ++Index)
            {
                if (Index > 0)
                    Spaced.AppendChar(TEXT('\u3000'));
                Spaced.AppendChar(Name[Index]);
            }
            Labels.Add({Geo((*LabelPoint)[0]->AsNumber(), (*LabelPoint)[1]->AsNumber(), 10), S(Region, TEXT("id")),
                        Spaced, true, S(Region, TEXT("labelPlate"))});
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
        this, [this, X, Y, Z, Size, G, Key](FHttpRequestPtr, FHttpResponsePtr Response, bool Ok) {
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
            auto *Texture = UTexture2D::CreateTransient(W->GetWidth(), W->GetHeight(), PF_B8G8R8A8);
            void *Ptr = Texture->GetPlatformData()->Mips[0].BulkData.Lock(LOCK_READ_WRITE);
            FMemory::Memcpy(Ptr, Pixels.GetData(), Pixels.Num());
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
            TileAttempts.Remove(Key);
            TrimTileCache();
        });
    if (!Request->ProcessRequest() && ActiveTiles.Remove(Key))
        TileFailed(Key);
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
    for (auto &Entry : TileMeshes)
        if (IsValid(Entry.Value.Get()))
            Entry.Value->SetVisibility(VisibleTiles.Contains(Entry.Key));
    for (const auto &Entry : Plan)
        if (!TileMeshes.Contains(Entry.Key) && !ActiveTiles.Contains(Entry.Key) && !TileFailures.Contains(Entry.Key))
            TileQueue.Add({Entry.Key, Entry.Value});
    TileQueue.Sort([](const FGeoTileRequest &A, const FGeoTileRequest &B) { return A.Priority > B.Priority; });
    TrimTileCache();
}
void AGeoMap::ApplyFrame(const TSharedPtr<FJsonObject> &Data)
{
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
    RefreshTiles(Lon, Lat, Range);
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
    constexpr int32 MaxActiveTiles = 18;
    while (ActiveTiles.Num() < MaxActiveTiles && !TileQueue.IsEmpty())
        StartTile(TileQueue.Pop(EAllowShrinking::No).Tile);
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
    const double Focus = N(F, TEXT("focus")), Reveal = N(F, TEXT("parentReveal"));
    const double ChildReveal = N(F, TEXT("childReveal"), 1);
    const auto Trace = O(F, TEXT("trace"));
    const auto Accents = O(F, TEXT("accents"));
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
        DimRects.Reset();
        for (auto &Layer : ShadowRects)
            Layer.Reset();
        TArray<TArray<FVector2D>> FocusRings;
        const FGeoRing *TraceRing = nullptr;
        if (N(Trace, TEXT("alpha")) > .01)
            for (const auto &Ring : Map->Rings)
                if ((Current.IsEmpty() ? Ring.Parent : Ring.Id == Current) && Ring.Points.Num() >= 4 &&
                    (!TraceRing || Ring.Lengths.Last() > TraceRing->Lengths.Last()))
                    TraceRing = &Ring;
        for (const auto &Ring : Map->Rings)
        {
            const bool Focused = FocusId.IsEmpty() ? Ring.Parent : Ring.Id == FocusId;
            if (Focused && Focus > .001)
                FocusRings.Add(ProjectFocusRing(Ring.Points, Map->Camera, Size.X, Size.Y));
            const double Accent = Ring.Parent ? N(F, TEXT("parentAccent")) : N(Accents, *Ring.Id);
            const bool Show = Ring.Parent || (ChildReveal > .01 && Ring.Id == Current);
            if (!Show || Ring.Points.Num() < 2)
                continue;
            FVector2D A;
            bool HasA = PlayerOwner->ProjectWorldLocationToScreen(Ring.Points[0], A);
            const double Length = Ring.Lengths.IsEmpty() ? 1 : FMath::Max(1., Ring.Lengths.Last());
            for (int I = 1; I < Ring.Points.Num(); I++)
            {
                FVector2D B;
                const bool HasB = PlayerOwner->ProjectWorldLocationToScreen(Ring.Points[I], B);
                if (HasA && HasB &&
                    !(FMath::Max(A.X, B.X) < -20 || FMath::Min(A.X, B.X) > Size.X + 20 || FMath::Max(A.Y, B.Y) < -20 ||
                      FMath::Min(A.Y, B.Y) > Size.Y + 20))
                    Strokes.Add(
                        {A, B, Ring.Parent, &Ring == TraceRing, Ring.Lengths[I - 1] / Length,
                         Ring.Lengths[I] / Length, Accent});
                A = B;
                HasA = HasB;
            }
        }
        for (const auto &Fill : Map->Fills)
        {
            if (Focus <= .001 || !(FocusId.IsEmpty() ? Fill.Parent : Fill.Id == FocusId))
                continue;
            TArray<FVector2D> Points;
            TArray<bool> Valid;
            for (const auto &Vertex : Fill.Vertices)
            {
                FVector2D Pixel;
                Valid.Add(PlayerOwner->ProjectWorldLocationToScreen(Vertex, Pixel));
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
        // Active-edge sweep: mask outside all focused rings using even/odd parity,
        // including holes and islands. Cost scales with visible edges, not pixels.
        struct Edge
        {
            double X, Step;
            int End;
        };
        const int Band = 2, Rows = FocusRings.IsEmpty() ? 0 : FMath::CeilToInt(double(Size.Y) / Band);
        TArray<TArray<Edge>> Starts;
        Starts.SetNum(Rows);
        using FSpans = TArray<FVector2D, TInlineAllocator<4>>;
        TArray<FSpans> InsideRows, OutsideRows;
        InsideRows.SetNum(Rows);
        OutsideRows.SetNum(Rows);
        TArray<Edge> Active;
        for (const auto &Ring : FocusRings)
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
    }
    const auto DrawRects = [this](const TArray<FVector4> &Rects, const FLinearColor &Color) {
        for (const auto &Rect : Rects)
        {
            FCanvasTileItem Tile(FVector2D(Rect.X, Rect.Y), FVector2D(Rect.Z, Rect.W), Color);
            Tile.BlendMode = SE_BLEND_Translucent;
            Canvas->DrawItem(Tile);
        }
    };
    DrawRects(DimRects, FLinearColor(.018, .024, .022, (FocusId.IsEmpty() ? .48 : .22) * Focus));
    const double ShadowOpacity[] = {.08, .15, .33};
    for (int Layer = 0; Layer < UE_ARRAY_COUNT(ShadowRects); ++Layer)
        DrawRects(ShadowRects[Layer], FLinearColor(.006, .010, .010, ShadowOpacity[Layer] * Focus));
    // The county arrives as a wipe: a straight front travels across the shape and
    // everything behind it is drawn, nothing ahead of it is. The front is placed on
    // the polygon's own projected extent — the world-space AABB projects far wider
    // than the county once perspective is in play, which made the wipe finish early —
    // so it starts at one edge and lands just past the other. `contextErasing` says
    // which way the front is travelling, which only tints the cut.
    const double Wipe = FMath::Clamp(ContextReveal, 0., 1.);
    const double Erasing = FMath::Clamp(N(F, TEXT("contextErasing"), 0), 0., 1.);
    struct FProjectedFill
    {
        TArray<FVector2D> Points;
        TArray<bool> Valid;
    };
    TArray<FProjectedFill> Projected;
    double CountyLeft = 0, CountyRight = 0, FrontX = 0;
    bool CountyFramed = false;
    // Sutherland-Hodgman against the single axis the wipe moves along: keeps the
    // blade dead straight instead of letting the triangulation show through.
    const auto ClipTriangle = [](const FVector2D &A, const FVector2D &B, const FVector2D &C, double X,
                                 const FLinearColor &Color, TArray<FCanvasUVTri> &Out) {
        FVector2D Poly[4];
        int Count = 0;
        const FVector2D In[3] = {A, B, C};
        for (int I = 0; I < 3; ++I)
        {
            const FVector2D From = In[I], To = In[(I + 1) % 3];
            const bool FromIn = From.X <= X, ToIn = To.X <= X;
            if (FromIn)
                Poly[Count++] = From;
            if (FromIn != ToIn)
                Poly[Count++] = FMath::Lerp(From, To, (X - From.X) / (To.X - From.X));
        }
        for (int I = 1; I + 1 < Count; ++I)
        {
            FCanvasUVTri Triangle;
            Triangle.V0_Pos = Poly[0];
            Triangle.V1_Pos = Poly[I];
            Triangle.V2_Pos = Poly[I + 1];
            Triangle.V0_UV = Triangle.V1_UV = Triangle.V2_UV = FVector2D::ZeroVector;
            Triangle.V0_Color = Triangle.V1_Color = Triangle.V2_Color = Color;
            Out.Add(Triangle);
        }
    };
    if (ContextAlpha > .01 && Wipe > .0005 && Map->ContextFills.Num())
    {
        Projected.SetNum(Map->ContextFills.Num());
        for (int Filled = 0; Filled < Map->ContextFills.Num(); ++Filled)
        {
            for (const auto &Vertex : Map->ContextFills[Filled].Vertices)
            {
                FVector2D Pixel = FVector2D::ZeroVector;
                const bool OnScreen = PlayerOwner->ProjectWorldLocationToScreen(Vertex, Pixel);
                Projected[Filled].Valid.Add(OnScreen);
                Projected[Filled].Points.Add(Pixel);
                if (!OnScreen)
                    continue;
                if (!CountyFramed)
                {
                    CountyLeft = CountyRight = Pixel.X;
                    CountyFramed = true;
                }
                CountyLeft = FMath::Min(CountyLeft, Pixel.X);
                CountyRight = FMath::Max(CountyRight, Pixel.X);
            }
        }
        FrontX = FMath::Lerp(CountyLeft, CountyRight, Wipe);
        const FLinearColor FloodBody(.05, .28, .66, .30 * ContextAlpha);
        TArray<FCanvasUVTri> ContextTriangles;
        for (int Filled = 0; Filled < Projected.Num(); ++Filled)
        {
            const auto &Fill = Map->ContextFills[Filled];
            const auto &Entry = Projected[Filled];
            for (int I = 0; I + 2 < Fill.Indices.Num(); I += 3)
            {
                const int A = Fill.Indices[I], B = Fill.Indices[I + 1], C = Fill.Indices[I + 2];
                if (!Entry.Valid[A] || !Entry.Valid[B] || !Entry.Valid[C])
                    continue;
                ClipTriangle(Entry.Points[A], Entry.Points[B], Entry.Points[C], FrontX, FloodBody, ContextTriangles);
            }
        }
        if (ContextTriangles.Num())
        {
            FCanvasTriangleItem Fill(ContextTriangles, GWhiteTexture);
            Fill.BlendMode = SE_BLEND_Translucent;
            Canvas->DrawItem(Fill);
        }
        // The blade itself: one hot hairline sitting exactly on the cut. No trail —
        // a soft gradient behind it read as a translucent panel floating over the
        // terrain, and a PPT wipe is a clean edge anyway.
        const double BladeGain = FMath::Clamp(FMath::Min(Wipe, 1. - Wipe) / .05, 0., 1.) * ContextAlpha;
        if (BladeGain > .002 && Map->ContextRings.Num())
        {
            TArray<double> Cuts;
            for (const auto &Ring : Map->ContextRings)
                for (int I = 0; I + 1 < Ring.Points.Num(); I++)
                {
                    FVector2D A, B;
                    if (!PlayerOwner->ProjectWorldLocationToScreen(Ring.Points[I], A) ||
                        !PlayerOwner->ProjectWorldLocationToScreen(Ring.Points[I + 1], B))
                        continue;
                    if ((A.X - FrontX) * (B.X - FrontX) > 0)
                        continue;
                    const double Span = B.X - A.X;
                    Cuts.Add(FMath::Abs(Span) < .001 ? A.Y : FMath::Lerp(A.Y, B.Y, (FrontX - A.X) / Span));
                }
            Cuts.Sort();
            const double BladeWidth = FMath::Max(1.5, 2.2 * Scale);
            for (int I = 0; I + 1 < Cuts.Num(); I += 2)
            {
                const double Top = Cuts[I], Height = Cuts[I + 1] - Cuts[I];
                if (Height < 1)
                    continue;
                FCanvasTileItem Blade(FVector2D(FrontX - BladeWidth * .5, Top), FVector2D(BladeWidth, Height),
                                      FLinearColor(.76, .95, 1, float((.52 + .14 * Erasing) * BladeGain)));
                Blade.BlendMode = SE_BLEND_Translucent;
                Canvas->DrawItem(Blade);
            }
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
                Valid.Add(PlayerOwner->ProjectWorldLocationToScreen(Vertex, Pixel));
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
    const FLinearColor TownEdge(.031, .070, .026), VillageEdge(.070, .480, .540);
    const FLinearColor ContextEdge(.35, .43, .41), DarkEdge(.009, .018, .021);
    TArray<FCanvasUVTri> BoundaryTriangles;
    const auto AddStroke = [&BoundaryTriangles](const FVector2D &A, const FVector2D &B, double Width,
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
        BoundaryTriangles.Add(Triangle);
        Triangle.V1_Pos = Triangle.V2_Pos;
        Triangle.V2_Pos = B - Offset;
        Triangle.V1_Color = ColorB;
        BoundaryTriangles.Add(Triangle);
    };
    if (CountyFramed && Map->ContextRings.Num())
    {
        // The county rim follows the same blade: segments ahead of the front are
        // not drawn, and the couple of centimetres of rim right under the blade
        // brighten so the edge reads as a hot cut rather than a hard clip.
        const FLinearColor ParentLine(.36, .70, .96), CrestLine(.62, .92, 1);
        for (const auto &Ring : Map->ContextRings)
        {
            for (int I = 0; I + 1 < Ring.Points.Num(); I++)
            {
                FVector2D A, B;
                if (!PlayerOwner->ProjectWorldLocationToScreen(Ring.Points[I], A) ||
                    !PlayerOwner->ProjectWorldLocationToScreen(Ring.Points[I + 1], B))
                    continue;
                if ((A.X < -100 && B.X < -100) || (A.X > Size.X + 100 && B.X > Size.X + 100) ||
                    (A.Y < -100 && B.Y < -100) || (A.Y > Size.Y + 100 && B.Y > Size.Y + 100))
                    continue;
                if (A.X > FrontX && B.X > FrontX)
                    continue;
                if (A.X > FrontX)
                    A = FMath::Lerp(A, B, (FrontX - A.X) / (B.X - A.X));
                else if (B.X > FrontX)
                    B = FMath::Lerp(B, A, (FrontX - B.X) / (A.X - B.X));
                const double Crest = FMath::Clamp(1. - FMath::Abs((A.X + B.X) * .5 - FrontX) / (42. * Scale), 0., 1.);
                const FLinearColor Line = ParentLine + (CrestLine - ParentLine) * float(Crest);
                const double LineAlpha = ContextAlpha;
                // Keep the county rim at the same hairline weight as the town outline
                // (pre-4fcd4ef look). A wide dark underlay read as a grey wall.
                AddStroke(A, B, 1.6 * Scale, FLinearColor(Line.R, Line.G, Line.B, .78 * LineAlpha),
                          FLinearColor(Line.R, Line.G, Line.B, .78 * LineAlpha));
            }
        }
    }
    for (const auto &Stroke : Strokes)
    {
        if (!Stroke.Parent)
        {
            // Villages already toured keep only their plate; the village being toured
            // carries the thick white rim of the reference reel — a soft halo plus a
            // solid core, so the boundary reads even over bright imagery.
            // Fade with the accent instead of cutting: at a hand-off the old village
            // dims out while the new one lights up, so the rim never snaps away.
            if (Stroke.Accent < .02)
                continue;
            const FLinearColor Rim(.93, 1., .90);
            const float A = float(FMath::Clamp(Stroke.Accent, 0., 1.));
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
        // Single hairline, no dark underlay: the raised 3D rim already frames the town.
        const double BaseWidth = FMath::Lerp(1.2f, 1.7f, float(Stroke.Accent)) * Scale;
        AddStroke(Stroke.A, End, BaseWidth, Color, Color);
    }
    const double Head = N(Trace, TEXT("progress")), TraceAlpha = N(Trace, TEXT("alpha"));
    if (TraceAlpha > .01)
        for (int Pass = 0; Pass < 2; ++Pass)
            for (const auto &Stroke : Strokes)
            {
                if (!Stroke.Trace)
                    continue;
                const double Start = FMath::Max(Head - .065, Stroke.Start), End = FMath::Min(Head, Stroke.End);
                if (End <= Start)
                    continue;
                const double Span = Stroke.End - Stroke.Start;
                const FVector2D A = FMath::Lerp(Stroke.A, Stroke.B, (Start - Stroke.Start) / Span);
                const FVector2D B = FMath::Lerp(Stroke.A, Stroke.B, (End - Stroke.Start) / Span);
                const double Opacity = TraceAlpha * (Pass == 0 ? .14 : .98);
                const FLinearColor Trail(1, .79, .18);
                AddStroke(A, B, (Pass == 0 ? 9.5 : 3.3) * Scale,
                          Trail.CopyWithNewOpacity((1 - (Head - Start) / .065) * Opacity),
                          Trail.CopyWithNewOpacity((1 - (Head - End) / .065) * Opacity));
            }
    if (BoundaryTriangles.Num())
    {
        FCanvasTriangleItem Lines(BoundaryTriangles, GWhiteTexture);
        Lines.BlendMode = SE_BLEND_Translucent;
        Canvas->DrawItem(Lines);
    }
    const double ContextLabelAlpha = ContextAlpha * FMath::SmoothStep(.82, 1., ContextReveal) * LabelsReveal;
    if (ContextLabelAlpha > .05 && !Map->ContextLabel.Name.IsEmpty())
    {
        FVector2D Point;
        if (PlayerOwner->ProjectWorldLocationToScreen(Map->ContextLabel.Position, Point))
        {
            float W, H;
            Canvas->StrLen(LabelFont, Map->ContextLabel.Name, W, H);
            const float TextScale = 42 * Scale / FMath::Max(1.f, H);
            const FLinearColor ContextColor(.72, .90, 1, .85 * ContextLabelAlpha);
            FCanvasTextItem Text(Point, FText::FromString(Map->ContextLabel.Name), LabelFont, ContextColor);
            Text.bCentreX = true;
            Text.bCentreY = true;
            Text.Scale = FVector2D(TextScale);
            const FLinearColor Outline = DarkEdge.CopyWithNewOpacity(.90 * ContextLabelAlpha);
            Text.SetColor(Outline);
            for (const FVector2D Offset : {FVector2D(-1.5, 0), FVector2D(1.5, 0), FVector2D(0, -1.5), FVector2D(0, 1.5)})
                Canvas->DrawItem(Text, Point + Offset);
            Text.SetColor(ContextColor);
            Canvas->DrawItem(Text, Point);
        }
    }
    struct FLabelDraw
    {
        FString Id, Name, PlatePath;
        FVector2D Anchor, Extent;
        FLinearColor Color;
        float TextScale, Emphasis, IconSize, PlateHeight;
        UTexture2D *PlateTexture = nullptr;
        int32 Priority;
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
    for (const auto &Label : Map->Labels)
    {
        const TSharedPtr<FJsonObject> *Style = nullptr;
        if (!Label.Parent && !Styles->TryGetObjectField(Label.Id, Style))
            continue;
        const double Alpha = Label.Parent ? N(F, TEXT("parentLabel")) : N(*Style, TEXT("alpha"));
        if (Alpha <= .01 || Label.Name.IsEmpty())
            continue;
        FVector2D Point;
        if (!PlayerOwner->ProjectWorldLocationToScreen(Label.Position, Point))
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
        // The town name sits 50% larger than it used to: it is the only label on screen at
        // that moment and has to hold the frame while the boundary beam finishes.
        const float SizePx = (Label.Parent ? 120.f : FMath::Lerp(35.f, 64.f, Emphasis) * (Primary ? 1.06f : 1.f))
                             * Scale * FMath::Lerp(1.f, Primary ? .90f : .82f, Ramp(.5, 3));
        float Width, Height;
        Canvas->StrLen(LabelFont, Label.Name, Width, Height);
        const float TextScale = FMath::Min(SizePx / FMath::Max(1.f, GlyphHeight), Size.X * .80f / FMath::Max(1.f, Width));
        FVector2D Extent = FVector2D(Width, Height) * TextScale * .5
                           + (CurrentVillage ? FVector2D(12, 6) : FVector2D(5, 3)) * Scale;
        const FLinearColor Color = FMath::Lerp(FLinearColor(.86, .91, .94), FLinearColor::White,
                                               Primary ? 1.f : Emphasis).CopyWithNewOpacity(Opacity);
        // The town's name is plain text on the map, like the Cesium build: no pin and no
        // plaque. Villages keep the pin because they are the subject of their own shot.
        const float IconSize = CurrentVillage
            ? 150.f * Scale * FMath::Lerp(1.f, .90f, Ramp(.5, 3))
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
                        IconSize, PlateHeight, PlateTexture, CurrentVillage ? 2 : Label.Parent ? 1 : 0});
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
    for (const auto &Label : DrawLabels)
    {
        const bool Pinned = Label.IconSize > 0;
        const double Gap = (Pinned ? 20 : 12) * Scale;
        const double X = Label.Extent.X + Gap, Y = Label.Extent.Y + Gap;
        const double BaseY = Pinned ? -(Label.IconSize + Gap + Label.Extent.Y) : 0;
        TArray<FVector2D> Offsets;
        if (Pinned)
            Offsets = {FVector2D(0, BaseY), FVector2D(0, BaseY - Y), FVector2D(X, BaseY),
                       FVector2D(-X, BaseY), FVector2D(X, BaseY - Y), FVector2D(-X, BaseY - Y),
                       FVector2D(0, BaseY - 2 * Y)};
        else
            Offsets = {{0, 0}, {0, -Y}, {X, 0}, {-X, 0}, {0, Y},
                       {X, -Y}, {-X, -Y}, {0, -Y - 60 * Scale}, {0, Y + 60 * Scale}};
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
        if (Pinned)
        {
            // The pin and its plaque are one unit: keep the plaque centered directly above
            // the pin and never draw a leader line to it.
            const FVector2D Point = Label.Anchor + FVector2D(0, BaseY);
            Bounds = FBox2D(Point - Label.Extent, Point + Label.Extent);
            Selected = 0;
        }
        else
        {
            // Reuse a valid placement during motion. A primary name may fall back to
            // covering a line if the remaining space is needed for captions or other names.
            for (int32 Pass = 0; Pass < (Label.Priority ? 2 : 1) && Selected == INDEX_NONE; ++Pass)
                for (int32 Order = Previous ? -1 : 0; Order < OffsetCount; ++Order)
                {
                    const int32 Candidate = Order < 0 ? *Previous : Order;
                    if (Order >= 0 && Previous && Candidate == *Previous)
                        continue;
                    const FVector2D Point = Label.Anchor + Offsets[Candidate];
                    const FBox2D Box(Point - Label.Extent, Point + Label.Extent);
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
                continue;
        }
        Occupied.Add(Bounds.ExpandBy(4 * Scale));
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
        FCanvasTextItem Text(Position, FText::FromString(Label.Name), LabelFont, Label.Color);
        Text.bCentreX = true;
        Text.bCentreY = true;
        Text.Scale = FVector2D(Label.TextScale);
        const double Halo = FMath::Max(1.25, (Label.Priority ? 2.65 : 1.9) * Scale);
        const FLinearColor Outline = DarkEdge.CopyWithNewOpacity(.93 * Label.Color.A);
        Text.SetColor(Outline);
        for (const FVector2D Offset : {FVector2D(-Halo, 0), FVector2D(Halo, 0), FVector2D(0, -Halo), FVector2D(0, Halo)})
            Canvas->DrawItem(Text, Position + Offset);
        Text.SetColor(Label.Color);
        Text.bOutlined = true;
        Text.OutlineColor = Outline;
        Canvas->DrawItem(Text, Position);
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
