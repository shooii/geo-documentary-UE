#include "GeoMap.h"
#include "Camera/CameraComponent.h"
#include "CanvasItem.h"
#include "Engine/Canvas.h"
#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
#include "Engine/Texture2D.h"
#include "HAL/IConsoleManager.h"
#include "HAL/PlatformFileManager.h"
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
    if (auto *Limit = IConsoleManager::Get().FindConsoleVariable(TEXT("t.MaxFPS")))
        Limit->Set(30.f, ECVF_SetByCode);
    if (auto *Rate = IConsoleManager::Get().FindConsoleVariable(TEXT("PixelStreaming2.WebRTC.Fps")))
        Rate->Set(30, ECVF_SetByCode);
    FParse::Value(FCommandLine::Get(), TEXT("GeoCaptureRoot="), CaptureRoot);
    TileMaterial = LoadObject<UMaterialInterface>(nullptr, TEXT("/Game/Geo/M_Tile.M_Tile"));
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
    auto J = MakeShared<FJsonObject>();
    J->SetStringField(TEXT("type"), TEXT("geo-video-ue"));
    J->SetStringField(TEXT("requestId"), Id);
    if (!Error.IsEmpty())
        J->SetStringField(TEXT("error"), Error);
    J->SetNumberField(TEXT("pendingTiles"), PendingTiles);
    J->SetNumberField(TEXT("failedTiles"), FailedTiles);
    J->SetStringField(TEXT("imagery"), ImageryProvider);
    J->SetNumberField(TEXT("loadedTiles"), Resources.Num() / 3);
    J->SetNumberField(TEXT("frameMs"), AverageFrameMs);
    J->SetNumberField(TEXT("fps"), AverageFrameMs > 0 ? 1000 / AverageFrameMs : 0);
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
    int32 G = ++Generation;
    auto R = FHttpModule::Get().CreateRequest();
    R->SetURL(Url);
    R->SetVerb(TEXT("GET"));
    R->OnProcessRequestComplete().BindWeakLambda(this, [this, Id, G](FHttpRequestPtr, FHttpResponsePtr Response,
                                                                     bool Ok) {
        if (G != Generation)
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
        DetailTiles.Reset();
        PreviousDetailTiles.Reset();
        for (auto &X : Resources)
            if (auto *C = Cast<UProceduralMeshComponent>(X))
                C->DestroyComponent();
        Resources.Empty();
        Rings.Empty();
        Fills.Empty();
        BoundaryVertices = 0;
        FGeoTileRequest OldRequest;
        while (TileRequests.Dequeue(OldRequest))
        {
        }
        Labels.Empty();
        TileKeys.Empty();
        DetailZoom = -1;
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
            Labels.Add({Geo((*LabelPoint)[0]->AsNumber(), (*LabelPoint)[1]->AsNumber(), 10), S(Region, TEXT("id")),
                        S(Region, TEXT("name")), true});
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
                                Out.Points.Add(Geo(P[0]->AsNumber(), P[1]->AsNumber(), 5));
                        }
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
                if (Props->TryGetArrayField(TEXT("labelPoint"), P) && P->Num() >= 2)
                {
                    Labels.Add({Geo((*P)[0]->AsNumber(), (*P)[1]->AsNumber(), 10), S(Props, TEXT("id")),
                                S(Props, TEXT("name")), Parent});
                }
            }
        for (int32 X = 0; X < 4; X++)
            for (int32 Y = 0; Y < 4; Y++)
                Tile(2, X, Y, false);
        RefreshTiles(OriginLon, OriginLat, 30000);
        Respond(Id);
    });
    R->ProcessRequest();
}
void AGeoMap::Tile(int32 Z, int32 X, int32 Y, bool Detail)
{
    int32 Size = 1 << Z;
    if (Y < 0 || Y >= Size)
        return;
    X = (X % Size + Size) % Size;
    FString Key = FString::Printf(TEXT("%d/%d/%d"), Z, X, Y);
    if (TileKeys.Contains(Key))
        return;
    TileKeys.Add(Key);
    int32 G = Generation;
    PendingTiles++;
    auto R = FHttpModule::Get().CreateRequest();
    FString Url = TileTemplate;
    Url.ReplaceInline(TEXT("{z}"), *FString::FromInt(Z));
    Url.ReplaceInline(TEXT("{x}"), *FString::FromInt(X));
    Url.ReplaceInline(TEXT("{y}"), *FString::FromInt(Y));
    R->SetURL(Url);
    R->OnProcessRequestComplete().BindWeakLambda(
        this, [this, Z, X, Y, Size, G, Key, Detail](FHttpRequestPtr, FHttpResponsePtr Response, bool Ok) {
            ActiveTileRequests--;
            if (G != Generation)
                return;
            PendingTiles--;
            if (!Ok || !Response || Response->GetResponseCode() != 200)
            {
                FailedTiles++;
                TileKeys.Remove(Key);
                return;
            }
            if (Detail && Z != DetailZoom)
                return;
            auto &M = FModuleManager::LoadModuleChecked<IImageWrapperModule>(TEXT("ImageWrapper"));
            auto Type = M.DetectImageFormat(Response->GetContent().GetData(), Response->GetContentLength());
            if (Type == EImageFormat::Invalid)
            {
                FailedTiles++;
                return;
            }
            auto W = M.CreateImageWrapper(Type);
            TArray64<uint8> Pixels;
            if (!W->SetCompressed(Response->GetContent().GetData(), Response->GetContentLength()) ||
                !W->GetRaw(ERGBFormat::BGRA, 8, Pixels))
            {
                FailedTiles++;
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
            const int32 Steps = Z == 2 ? 24 : 4;
            for (int32 J = 0; J <= Steps; J++)
                for (int32 I = 0; I <= Steps; I++)
                {
                    double U = double(I) / Steps, V = double(J) / Steps, Lon = (X + U) / Size * 360 - 180,
                           Lat = FMath::RadiansToDegrees(FMath::Atan(FMath::Sinh(PI * (1 - 2 * (Y + V) / Size))));
                    Vertices.Add(Geo(Lon, Lat, Detail ? 2+Z*.1 : 0));
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
            if (Detail)
                DetailTiles.Add(Key, Mesh);
        });
    TileRequests.Enqueue({R, Detail});
}
void AGeoMap::RefreshTiles(double Lon, double Lat, double Range)
{
    const int32 Z = FMath::Clamp(FMath::FloorToInt(FMath::Log2(40075016.0 / FMath::Max(500.0, Range * .14))), 3, 15);
    if (Z != DetailZoom)
    {
        FGeoTileRequest Queued;
        TArray<FGeoTileRequest> Base;
        while (TileRequests.Dequeue(Queued))
        {
            if (Queued.Detail)
                PendingTiles--;
            else
                Base.Add(Queued);
        }
        for (const auto &Entry : Base)
            TileRequests.Enqueue(Entry);
        // Keep the previous LOD visible beneath incoming tiles during camera travel.
        for (const auto &Entry : DetailTiles)
            PreviousDetailTiles.Add(Entry.Value);
        DetailTiles.Reset();
        DetailZoom = Z;
        TileKeys.Empty();
    }
    int32 Size = 1 << Z, X = FMath::FloorToInt((Lon + 180) / 360 * Size),
          Y = FMath::FloorToInt(
              (1 - std::asinh(FMath::Tan(FMath::DegreesToRadians(FMath::Clamp(Lat, -85.0, 85.0)))) / PI) / 2 * Size);
    int32 MinX = X - 3, MaxX = X + 3, MinY = Y - 3, MaxY = Y + 3;
    if (Frame.IsValid() && Camera->GetComponentLocation().Z > Geo(Lon, Lat).Z + 100)
    {
        MinX = MinY = INT_MAX;
        MaxX = MaxY = INT_MIN;
        int32 W = 1080, H = 1920;
        if (auto *PC = GetWorld()->GetFirstPlayerController())
            PC->GetViewportSize(W, H);
        const double TX = FMath::Tan(FMath::DegreesToRadians(Camera->FieldOfView * .5)), TY = TX * H / FMath::Max(1, W);
        const FVector Target = Geo(Lon, Lat), Eye = Camera->GetComponentLocation();
        for (int SX : {-1, 1})
            for (int SY : {-1, 1})
            {
                const FVector Ray =
                    Camera->GetForwardVector() + Camera->GetRightVector() * TX * SX + Camera->GetUpVector() * TY * SY;
                if (Ray.Z >= -.01)
                    continue;
                const FVector Corner = Eye + Ray * ((Target.Z - Eye.Z) / Ray.Z);
                const double CornerLon =
                    Lon + (Corner.Y - Target.Y) / 100 / (111320 * FMath::Cos(FMath::DegreesToRadians(Lat)));
                const double CornerLat = FMath::Clamp(Lat + (Corner.X - Target.X) / 100 / 110570, -85., 85.);
                const int CX = FMath::FloorToInt((CornerLon + 180) / 360 * Size);
                const int CY =
                    FMath::FloorToInt((1 - std::asinh(FMath::Tan(FMath::DegreesToRadians(CornerLat))) / PI) / 2 * Size);
                MinX = FMath::Min(MinX, CX);
                MaxX = FMath::Max(MaxX, CX);
                MinY = FMath::Min(MinY, CY);
                MaxY = FMath::Max(MaxY, CY);
            }
        MinX = FMath::Clamp(MinX - 1, X - 12, X);
        MaxX = FMath::Clamp(MaxX + 1, X, X + 12);
        MinY = FMath::Clamp(MinY - 1, Y - 12, Y);
        MaxY = FMath::Clamp(MaxY + 1, Y, Y + 12);
    }
    for (int32 CX = MinX; CX <= MaxX; CX++)
        for (int32 CY = MinY; CY <= MaxY; CY++)
            Tile(Z, CX, CY, true);
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
    RefreshTiles(Lon, Lat, Range);
}
void AGeoMap::Tick(float Delta)
{
    Super::Tick(Delta);
    AverageFrameMs = AverageFrameMs == 0 ? Delta * 1000 : FMath::Lerp(AverageFrameMs, double(Delta * 1000), .05);
    FGeoTileRequest Request;
    while (ActiveTileRequests < 4 && TileRequests.Dequeue(Request))
    {
        ActiveTileRequests++;
        if (!Request.Request->ProcessRequest())
        {
            ActiveTileRequests--;
            PendingTiles--;
            FailedTiles++;
        }
    }
    if (PendingTiles == 0 && !PreviousDetailTiles.IsEmpty())
    {
        for (auto &Mesh : PreviousDetailTiles)
        {
            if (!IsValid(Mesh.Get()))
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
        PreviousDetailTiles.Reset();
    }
    if (CaptureId.IsEmpty())
        return;
    if (FPlatformTime::Seconds() - CaptureStarted > 45)
    {
        Respond(CaptureId, TEXT("Timed out waiting for imagery"));
        CaptureId.Empty();
        return;
    }
    if (PendingTiles > 0)
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
    const auto Trace = O(F, TEXT("trace"));
    const auto Accents = O(F, TEXT("accents"));
    if (CachedFrame != F || CachedSize != Size)
    {
        CachedFrame = F;
        CachedSize = Size;
        Strokes.Reset();
        FocusTriangles.Reset();
        DimRects.Reset();
        TArray<TArray<FVector2D>> FocusRings;
        for (const auto &Ring : Map->Rings)
        {
            const bool Focused = FocusId.IsEmpty() ? Ring.Parent : Ring.Id == FocusId;
            if (Focused && Focus > .001)
                FocusRings.Add(ProjectFocusRing(Ring.Points, Map->Camera, Size.X, Size.Y));
            const double Accent = Ring.Parent ? N(F, TEXT("parentAccent")) : N(Accents, *Ring.Id);
            const bool Show = Ring.Parent || Accent > .01 || N(F, TEXT("childReveal")) > .01;
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
                        {A, B, Ring.Parent, Ring.Id == Current, (Ring.Lengths[I - 1] + Ring.Lengths[I]) * .5 / Length, Accent});
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
                    DimRects.Add(FVector4(Left, Row * Band, Right - Left, Band));
                Left = I + 1 < Active.Num() ? FMath::Clamp(Active[I + 1].X, 0., double(Size.X)) : Size.X;
            }
            if (Left < Size.X)
                DimRects.Add(FVector4(Left, Row * Band, Size.X - Left, Band));
            for (auto &E : Active)
                E.X += E.Step;
        }
    }
    const FLinearColor Dim(.012, .026, .040, (FocusId.IsEmpty() ? .22 : .32) * Focus);
    for (const auto &Rect : DimRects)
    {
        FCanvasTileItem Tile(FVector2D(Rect.X, Rect.Y), FVector2D(Rect.Z, Rect.W), Dim);
        Tile.BlendMode = SE_BLEND_Translucent;
        Canvas->DrawItem(Tile);
    }
    if (FocusTriangles.Num())
    {
        const FLinearColor Tint = FocusId.IsEmpty() ? FLinearColor(.12, .66, .88, .065 * Focus)
                                                   : FLinearColor(1, .69, .24, .095 * Focus);
        for (auto &Triangle : FocusTriangles)
            Triangle.V0_Color = Triangle.V1_Color = Triangle.V2_Color = Tint;
        FCanvasTriangleItem Fill(FocusTriangles, GWhiteTexture);
        Fill.BlendMode = SE_BLEND_Translucent;
        Canvas->DrawItem(Fill);
    }
    for (int Pass = 0; Pass < 4; Pass++)
        for (const auto &Stroke : Strokes)
        {
            const float Accent = Stroke.Accent;
            if (Stroke.Parent && Stroke.Progress > Reveal)
                continue;
            if (Accent <= .01 && Pass != 2)
                continue;
            const FLinearColor Edge = Stroke.Parent ? FLinearColor(.24, .78, .96) : FLinearColor(1, .70, .25);
            const double Coverage = FMath::Clamp(FVector2D::Distance(Stroke.A, Stroke.B) / (6 * Scale), .08, 1.);
            FCanvasLineItem Line(Stroke.A, Stroke.B);
            if (Pass == 0)
            {
                Line.SetColor(Edge.CopyWithNewOpacity(.19 * Accent * Coverage));
                Line.LineThickness = 12 * Scale;
            }
            else if (Pass == 1)
            {
                Line.SetColor(FLinearColor(.008, .019, .030, .93 * Accent));
                Line.LineThickness = 7.0 * Scale;
            }
            else if (Pass == 2)
            {
                const FLinearColor Context(.55, .70, .75, Stroke.Parent ? .61 : .20);
                Line.SetColor(FMath::Lerp(Context, Edge.CopyWithNewOpacity(.98), Accent));
                Line.LineThickness = FMath::Lerp(Stroke.Parent ? 1.55f : .85f, 3.85f, Accent) * Scale;
            }
            else
            {
                Line.SetColor(FMath::Lerp(Edge, FLinearColor::White, .62f).CopyWithNewOpacity(.94 * Accent));
                Line.LineThickness = 1.55 * Scale;
            }
            Canvas->DrawItem(Line);
        }
    const double Head = N(Trace, TEXT("progress")), TraceAlpha = N(Trace, TEXT("alpha"));
    if (TraceAlpha > .01)
        for (const auto &Stroke : Strokes)
        {
            if (!(Current.IsEmpty() ? Stroke.Parent : Stroke.Current))
                continue;
            const double Behind = Head - Stroke.Progress;
            if (Behind < 0 || Behind > .065)
                continue;
            const double Strength = (1 - Behind / .065) * TraceAlpha;
            for (int Pass = 0; Pass < 3; Pass++)
            {
                FCanvasLineItem Line(Stroke.A, Stroke.B);
                Line.LineThickness = (Pass == 0 ? 12 : Pass == 1 ? 5 : 2.5) * Scale;
                const double Coverage=Pass<2?FMath::Clamp(FVector2D::Distance(Stroke.A,Stroke.B)/FMath::Max(.1f,Line.LineThickness),.025,1.):1.;
                Line.SetColor(FLinearColor(1,.72,.25,Strength*Coverage*(Pass==0?.035:Pass==1?.16:1)));
                Canvas->DrawItem(Line);
            }
        }
    struct FLabelDraw
    {
        FString Id, Name;
        FVector2D Position;
        FBox2D Bounds;
        FLinearColor Color;
        float Scale, Emphasis;
        bool Primary;
    };
    TArray<FLabelDraw> DrawLabels;
    const auto Styles = O(F, TEXT("labels"));
    const auto *Font = GEngine->GetLargeFont();
    float GlyphWidth, GlyphHeight;
    Canvas->StrLen(Font, TEXT("国"), GlyphWidth, GlyphHeight);
    const double Reference = FMath::Max(1., N(F, TEXT("labelReferenceDistance"), 38000));
    const FVector Eye = Map->Camera->GetComponentLocation();
    for (const auto &Label : Map->Labels)
    {
        const TSharedPtr<FJsonObject> *Style = nullptr;
        if (!Label.Parent && !Styles->TryGetObjectField(Label.Id, Style))
            continue;
        const double Alpha = Label.Parent ? N(F, TEXT("parentLabel")) : N(*Style, TEXT("alpha"));
        if (Alpha <= .01)
            continue;
        FVector2D Point;
        if (!PlayerOwner->ProjectWorldLocationToScreen(Label.Position, Point))
            continue;
        if (Label.Parent)
            Point.Y -= 18 * Scale;

        // The shader's NearFarScalar uses squared eye distance and a fifth-root ease.
        const double DistanceRatioSq = FVector::DistSquared(Eye, Label.Position) / FMath::Square(Reference * 100);
        const auto Ramp = [DistanceRatioSq](double Near, double Far) {
            return FMath::Pow(FMath::Clamp((DistanceRatioSq - Near * Near) / (Far * Far - Near * Near), 0., 1.), .2);
        };
        const float Opacity = Alpha * (1 - Ramp(1, 2.8));
        if (Opacity <= .01)
            continue;
        const float Emphasis = Label.Parent ? 0 : N(*Style, TEXT("emphasis"));
        const float SizePx = (Label.Parent ? 86 : 56) * Scale * (Label.Parent ? 1 : N(*Style, TEXT("scale"), 1))
                             * FMath::Lerp(1.1, .68, Ramp(.5, 3));
        const float TextScale = SizePx / FMath::Max(1.f, GlyphHeight);
        float Width, Height;
        Canvas->StrLen(Font, Label.Name, Width, Height);
        const FVector2D Extent = FVector2D(Width, Height) * TextScale * .5 + FVector2D(5, 3) * Scale;
        if (Point.X < 0 || Point.X > Size.X || Point.Y < 0 || Point.Y > Size.Y)
            continue;
        const FLinearColor Color = FMath::Lerp(FLinearColor::White, FLinearColor(1, .77, .35), .58f * Emphasis)
                                   .CopyWithNewOpacity(Opacity);
        DrawLabels.Add({Label.Id, Label.Name, Point, FBox2D(Point - Extent, Point + Extent), Color, TextScale,
                        Emphasis, Label.Parent || Label.Id == Current});
    }
    DrawLabels.Sort([this](const FLabelDraw &A, const FLabelDraw &B) {
        if (A.Primary != B.Primary)
            return A.Primary;
        if (A.Emphasis != B.Emphasis)
            return A.Emphasis > B.Emphasis;
        const bool WasVisible = VisibleLabelIds.Contains(A.Id), OtherWasVisible = VisibleLabelIds.Contains(B.Id);
        if (WasVisible != OtherWasVisible)
            return WasVisible;
        return A.Position.Y == B.Position.Y ? A.Position.X < B.Position.X : A.Position.Y < B.Position.Y;
    });
    VisibleLabelIds.Reset();
    TArray<FBox2D> Occupied;
    for (const auto &Label : DrawLabels)
    {
        if (Occupied.ContainsByPredicate([&Label](const FBox2D &Box) { return Box.Intersect(Label.Bounds); }))
            continue;
        Occupied.Add(Label.Bounds);
        VisibleLabelIds.Add(Label.Id);
        FCanvasTextItem Text(Label.Position, FText::FromString(Label.Name), Font, Label.Color);
        Text.bCentreX = true;
        Text.bCentreY = true;
        Text.Scale = FVector2D(Label.Scale);
        const double Radius = FMath::Max(1.25, 3.2 * Scale);
        Text.SetColor(FLinearColor(.008, .014, .024, Label.Color.A));
        for (int Direction = 0; Direction < 8; ++Direction)
        {
            const double Angle = Direction * PI / 4;
            Canvas->DrawItem(Text, Label.Position + FVector2D(FMath::Cos(Angle), FMath::Sin(Angle)) * Radius);
        }
        Text.SetColor(Label.Color);
        Text.Position = Label.Position;
        Canvas->DrawItem(Text);
    }
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
    CloudLayer(Map->CloudDeck, N(Clouds, TEXT("deck")), 1.05 + Raw * .16, (Raw - .5) * -28, (Raw - .5) * 20);
    CloudLayer(Map->CloudDeck, N(Clouds, TEXT("volume")) * .18, 1.5 + Raw * .8, (Raw - .5) * 100, (Raw - .5) * -70);
    CloudLayer(Map->CloudPass, N(Clouds, TEXT("veil")), 1.06 + Raw * .13, (Raw - .5) * -31, (Raw - .5) * 17);
    if (Map->ImageryProvider == TEXT("cesium-ion-world-imagery") && !Map->ImageryAttribution.IsEmpty())
    {
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
