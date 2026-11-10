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
class AGeoVolumetricSky;
class APostProcessVolume;
class IHttpRequest;
struct FGeoTileRequest
{
    FIntVector Tile;
    double Priority = 0;
};

/**
 * A tile that has arrived but whose texture upload has not run yet. Decoding and
 * uploading happens in the HTTP callback today, so a burst of eighteen responses in
 * one frame is eighteen texture uploads in that frame — a visible hitch on a moving
 * shot. They are queued here and drained a few per tick instead.
 */
struct FGeoTileImage
{
    FIntVector Key;
    int32 Width = 0, Height = 0;
    /** Scene generation the tile was fetched for; a stale one is dropped on upload. */
    int32 Generation = 0;
    TArray64<uint8> Pixels;
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
    /** Layers muted for diagnosis, parsed from GEO_BOUNDARY_OFF at BeginPlay. */
    uint8 BoundaryOff = 0;
    int32 BoundaryGeneration = -1;
    /** Parent rings — the slab that stays up for the whole scene. */
    TArray<int32> BoundaryPaths;
    /** Rings of the focused child, drawn as a second block on top of the slab. */
    TArray<int32> FocusPaths;
    /** Children already toured; their plates stay painted behind the current one. */
    TArray<FString> BoundaryVisited;
    double BoundaryHeight = 0, BoundaryLift = 0, BoundaryWidth = 0;
    double BoundaryFocusHeight = 0, BoundaryFocusWidth = 0;
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
    UPROPERTY() TObjectPtr<AGeoVolumetricSky> Sky;
    UPROPERTY() TObjectPtr<APostProcessVolume> PostProcess;
    bool UsesNativeClouds() const;
    TSharedPtr<FJsonObject> Frame;
    double OriginLon = 110, OriginLat = 20;
    int32 SceneRequest = 0, Generation = 0, PendingTiles = 0, FailedTiles = 0;
    UPROPERTY() TMap<FIntVector, TObjectPtr<UProceduralMeshComponent>> TileMeshes;
    TArray<FIntVector> TileCacheOrder;
    TSet<FIntVector> VisibleTiles, RequiredTiles, TileFailures;
    /** Tiles whose mesh is currently visible, so a refresh only touches edge tiles. */
    TSet<FIntVector> ShownTiles;
    /** Arrived tiles waiting for their texture upload; drained a few per tick. */
    TArray<FGeoTileImage> TileImages;
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
    /** Smoothed per-frame costs, reported as GEO_PROFILE so a regression is visible. */
    double ApplyMs = 0, RefreshMs = 0, HudMs = 0;
    /** Canvas quads the HUD emitted last frame; the shadow pass dominates them. */
    int32 HudRects = 0;
    /** HUD split: projecting rings vs. building the dim/shadow mask. */
    double HudRingsMs = 0, HudMaskMs = 0;
    int32 BoundaryVertices = 0;
    FVector Geo(double Lon, double Lat, double Height = 0) const;
    void Respond(FString RequestId, FString Error = TEXT(""));
    void LoadScene(const TSharedPtr<FJsonObject> &Data, FString RequestId);
    /**
     * Swaps only the basemap layer (tile template + provider). The rings, the fills,
     * the labels and the camera are left alone, so changing imagery never restarts
     * the scene and never costs a pixel-stream reconnect.
     */
    void SetImagery(const TSharedPtr<FJsonObject> &Data, FString RequestId);
    void ApplyFrame(const TSharedPtr<FJsonObject> &Data);
    void InitBoundaryEffects();
    /**
     * @param BaseFocus 0..1 strength of the parent slab, which never goes away once raised.
     * @param Focus     0..1 strength of the focused child's block on top of it.
     * @param Visited   Children whose tour already started. They keep a paler green
     *                  plate so the map accumulates relief instead of erasing it.
     */
    void UpdateBoundaryEffects(const FString &FocusId, const TArray<FString> &Visited, double BaseFocus, double Focus, double Time);
    void StartTile(const FIntVector &Key);
    /** Uploads a queued tile image. Returns false when the tile is no longer wanted. */
    void CommitTile(FGeoTileImage &&Image);
    void TileFailed(const FIntVector &Key);
    void TrimTileCache();
    void UpdateTileCounts();
    void RefreshTiles(double Lon, double Lat, double Range);
};
struct FGeoStroke
{
    FVector2D A, B;
    bool Parent = false, Trace = false, Touring = false;
    double Start = 0, End = 0, Accent = 0;
};
/** Screen-space triangles of a village whose tour already reached it. */
struct FGeoVisitedFill
{
    TArray<FCanvasUVTri> Triangles;
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
    TArray<FGeoVisitedFill> VisitedFills;
    TArray<FVector4> DimRects;
    TArray<FVector4> ShadowRects[3];
    UPROPERTY() TObjectPtr<UFont> LabelFont;
    /** Township names. A second atlas, rasterised large: one 64 px font made every big
     *  name a 2x upscale of a small bitmap. */
    UPROPERTY() TObjectPtr<UFont> TownFont;
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
