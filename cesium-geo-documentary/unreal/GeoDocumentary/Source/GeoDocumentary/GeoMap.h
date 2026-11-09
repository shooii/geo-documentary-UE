#pragma once
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Engine/Canvas.h"
#include "GameFramework/Actor.h"
#include "GameFramework/GameModeBase.h"
#include "GameFramework/HUD.h"
#include "GeoMap.generated.h"
class UCameraComponent;
class UFont;
class UProceduralMeshComponent;
class UMaterialInterface;
class UMaterialInstanceDynamic;
class UNiagaraComponent;
class UTexture2D;
class IHttpRequest;
struct FGeoTileRequest
{
    FIntVector Tile;
    double Priority = 0;
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
    FString PlatePath;
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
    UPROPERTY() TObjectPtr<UProceduralMeshComponent> BoundaryMesh;
    UPROPERTY() TArray<TObjectPtr<UMaterialInstanceDynamic>> BoundaryLayers;
    UPROPERTY() TArray<TObjectPtr<UNiagaraComponent>> BoundarySparks;
    FString BoundaryFocus;
    int32 BoundaryGeneration = -1;
    TArray<int32> BoundaryPaths;
    double BoundaryHeight = 0, BoundaryLift = 0, BoundaryWidth = 0;
    bool HasRaisedBoundary() const { return BoundaryLift > 0; }
    bool BoundaryEffectsCompiling() const;
    UPROPERTY() TObjectPtr<UTexture2D> CloudDeck;
    UPROPERTY() TObjectPtr<UTexture2D> CloudPass;
    UPROPERTY() TArray<TObjectPtr<UObject>> Resources;
    TArray<FGeoRing> Rings;
    TArray<FGeoFill> Fills;
    TArray<FGeoLabel> Labels;
    TArray<FGeoRing> ContextRings;
    TArray<FGeoFill> ContextFills;
    FGeoLabel ContextLabel;
    FBox ContextBounds = FBox(ForceInit);
    FVector ContextOrigin = FVector::ZeroVector;
    double ContextReachMeters = 0;
    bool HasContext = false;
    TSharedPtr<FJsonObject> Frame;
    double OriginLon = 110, OriginLat = 20;
    int32 SceneRequest = 0, Generation = 0, PendingTiles = 0, FailedTiles = 0;
    UPROPERTY() TMap<FIntVector, TObjectPtr<UProceduralMeshComponent>> TileMeshes;
    TArray<FIntVector> TileCacheOrder;
    TSet<FIntVector> VisibleTiles, RequiredTiles, TileFailures;
    TMap<FIntVector, uint8> TileAttempts;
    TMap<FIntVector, TSharedPtr<IHttpRequest, ESPMode::ThreadSafe>> ActiveTiles;
    TArray<FGeoTileRequest> TileQueue;
    FIntVector TileCenter = FIntVector(0, 0, -1);
    FIntPoint TileMin, TileMax;
    FString CaptureId, CaptureRoot;
    FString TileTemplate, ImageryProvider, ImageryAttribution;
    FString RenderProfile;
    FIntPoint RequestedSize;
    int32 CaptureIndex = 0, CaptureTicks = 0;
    double CaptureStarted = 0;
    double AverageFrameMs = 0;
    int32 BoundaryVertices = 0;
    FVector Geo(double Lon, double Lat, double Height = 0) const;
    void Respond(FString RequestId, FString Error = TEXT(""));
    void LoadScene(const TSharedPtr<FJsonObject> &Data, FString RequestId);
    void ApplyFrame(const TSharedPtr<FJsonObject> &Data);
    void InitBoundaryEffects();
    void UpdateBoundaryEffects(const FString &FocusId, double Focus, double Time);
    void StartTile(const FIntVector &Key);
    void TileFailed(const FIntVector &Key);
    void TrimTileCache();
    void UpdateTileCounts();
    void RefreshTiles(double Lon, double Lat, double Range);
};
struct FGeoStroke
{
    FVector2D A, B;
    bool Parent = false, Trace = false;
    double Start = 0, End = 0, Accent = 0;
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
    TArray<FVector4> ShadowRects[3];
    UPROPERTY() TObjectPtr<UFont> LabelFont;
    UPROPERTY() TObjectPtr<UTexture2D> LabelPin;
    UPROPERTY() TMap<FString, TObjectPtr<UTexture2D>> LabelPlates;
    TMap<FString, int32> LabelPlacements;
    int32 LabelGeneration = -1;
};
UCLASS()
class AGeoGameMode : public AGameModeBase
{
  GENERATED_BODY() public : AGeoGameMode();
    virtual void StartPlay() override;
};
