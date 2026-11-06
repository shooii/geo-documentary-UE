#pragma once
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Engine/Canvas.h"
#include "GameFramework/Actor.h"
#include "GameFramework/GameModeBase.h"
#include "GameFramework/HUD.h"
#include "GeoMap.generated.h"
class UCameraComponent;
class UProceduralMeshComponent;
class UMaterialInterface;
class UTexture2D;
class IHttpRequest;
struct FGeoTileRequest
{
    TSharedPtr<IHttpRequest, ESPMode::ThreadSafe> Request;
    bool Detail = false;
};

struct FGeoRing
{
    TArray<FVector> Points;
    TArray<double> Lengths;
    FString Id;
    bool Parent = false;
};
struct FGeoFill
{
    TArray<FVector> Vertices;
    TArray<int32> Indices;
    FString Id;
    bool Parent = false;
};
struct FGeoLabel
{
    FVector Position;
    FString Id, Name;
    bool Parent = false;
};

UCLASS()
class AGeoMap : public AActor
{
    GENERATED_BODY()
  public:
    AGeoMap();
    virtual void BeginPlay() override;
    virtual void Tick(float Delta) override;
    UFUNCTION() void OnInput(const FString &Descriptor);
    UPROPERTY() TObjectPtr<UActorComponent> Input;
    UPROPERTY() TObjectPtr<UCameraComponent> Camera;
    UPROPERTY() TObjectPtr<UMaterialInterface> TileMaterial;
    UPROPERTY() TObjectPtr<UTexture2D> CloudDeck;
    UPROPERTY() TObjectPtr<UTexture2D> CloudPass;
    UPROPERTY() TArray<TObjectPtr<UObject>> Resources;
    TArray<FGeoRing> Rings;
    TArray<FGeoFill> Fills;
    TArray<FGeoLabel> Labels;
    TSharedPtr<FJsonObject> Frame;
    double OriginLon = 110, OriginLat = 20;
    int32 Generation = 0, PendingTiles = 0, FailedTiles = 0;
    TSet<FString> TileKeys;
    TMap<FString, TObjectPtr<UProceduralMeshComponent>> DetailTiles;
    TArray<TObjectPtr<UProceduralMeshComponent>> PreviousDetailTiles;
    int32 DetailZoom = -1;
    FString CaptureId, CaptureRoot;
    FString TileTemplate, ImageryProvider;
    FString RenderProfile;
    FIntPoint RequestedSize;
    int32 CaptureIndex = 0, CaptureTicks = 0;
    double CaptureStarted = 0;
    double AverageFrameMs = 0;
    int32 BoundaryVertices = 0, ActiveTileRequests = 0;
    TQueue<FGeoTileRequest> TileRequests;
    FVector Geo(double Lon, double Lat, double Height = 0) const;
    void Respond(FString RequestId, FString Error = TEXT(""));
    void LoadScene(const TSharedPtr<FJsonObject> &Data, FString RequestId);
    void ApplyFrame(const TSharedPtr<FJsonObject> &Data);
    void Tile(int32 Z, int32 X, int32 Y, bool Detail);
    void RefreshTiles(double Lon, double Lat, double Range);
};
struct FGeoStroke
{
    FVector2D A, B;
    bool Parent = false, Current = false;
    double Progress = 0;
};
UCLASS()
class AGeoHUD : public AHUD
{
    GENERATED_BODY()
  public:
    virtual void DrawHUD() override;

  private:
    TArray<FGeoStroke> Strokes;
    TSharedPtr<FJsonObject> CachedFrame;
    FIntPoint CachedSize;
    TArray<FCanvasUVTri> FocusTriangles;
    TArray<FVector4> DimRects;
};
UCLASS()
class AGeoGameMode : public AGameModeBase
{
  GENERATED_BODY() public : AGeoGameMode();
    virtual void StartPlay() override;
};
