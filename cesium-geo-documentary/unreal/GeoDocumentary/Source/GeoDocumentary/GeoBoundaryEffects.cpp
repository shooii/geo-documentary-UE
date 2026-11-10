#include "GeoMap.h"
#include "Algo/BinarySearch.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "NiagaraComponent.h"
#include "NiagaraSystem.h"
#include "ProceduralMeshComponent.h"

namespace
{
// Two blocks share the mesh: the parent's slab, which is the base of every shot in
// the scene, and the focused child's block, which stands on top of it. Each needs its
// own face and curtain so the two can carry different lifts.
// Three layers share the mesh: the parent's slab (face + curtain) and one flat plate
// carrying every village already toured. The village being toured is painted by the
// HUD fill, so the hand-off when the tour moves on is a single colour change.
// GEO_BOUNDARY_OFF=face|curtain|child|all still mutes them for A/B work.
enum EBoundaryLayer { Face, Curtain, VisitedFace, LayerCount };

// The material only knows two shapes: 0 = flat top face, 1 = vertical curtain.
// Indexing it with `Layer & 1` worked while there were exactly two pairs; with the
// visited plate in between it would hand the face material a curtain.
constexpr int32 BoundaryMaterialLayer[LayerCount] = { 0, 1, 0 };

uint8 ParseBoundaryOff()
{
    FString Spec = FPlatformMisc::GetEnvironmentVariable(TEXT("GEO_BOUNDARY_OFF"));
    Spec.TrimStartAndEndInline();
    Spec.ToLowerInline();
    if (Spec.IsEmpty())
        return 0;
    if (Spec == TEXT("all"))
        return (1 << LayerCount) - 1;
    uint8 Mask = 0;
    TArray<FString> Parts;
    Spec.ParseIntoArray(Parts, TEXT(","), true);
    for (FString Part : Parts)
    {
        Part.TrimStartAndEndInline();
        if (Part == TEXT("face")) Mask |= (1 << Face) | (1 << VisitedFace);
        else if (Part == TEXT("curtain")) Mask |= 1 << Curtain;
        else if (Part == TEXT("child")) Mask |= 1 << VisitedFace;
    }
    return Mask;
}

// Block proportions are derived from the footprint the block covers, so a village
// block is as tall relative to itself as the town's is to the town.
double BlockHeight(const FBox &Bounds)
{
    // FBox::IsValid is a flag on the struct, not a predicate.
    // The slab has to read as a slab, not a bevel: the visible height is this number
    // times the parent strength in GeoMap (0.16 focus -> ~0.09), so a factor of .104
    // left a 26 km township only ~230 m thick. .135 puts it near 300 m, which is the
    // first step that reads as relief at the overview framing without turning the
    // block into a wall in the village shots.
    return Bounds.IsValid ? FMath::Clamp(Bounds.GetSize().Size2D() * .135, 4800., 500000.) : 0.;
}
double BlockWidth(const FBox &Bounds)
{
    return Bounds.IsValid ? FMath::Clamp(Bounds.GetSize().Size2D() * .0022, 110., 21000.) : 0.;
}

struct FBoundarySection
{
    TArray<FVector> Vertices;
    TArray<int32> Indices;
    TArray<FVector2D> UVs;
    TArray<FLinearColor> Colors;

    void Add(const FVector &Point, const FVector2D &UV, float Lift)
    {
        Vertices.Add(Point);
        UVs.Add(UV);
        Colors.Add(FLinearColor(1, 1, 1, Lift));
    }

    void Connect()
    {
        const int32 I = Vertices.Num() - 4;
        Indices.Append({I, I + 1, I + 2, I + 2, I + 1, I + 3});
    }

    void Create(UProceduralMeshComponent &Mesh, int32 Section) const
    {
        if (!Indices.IsEmpty())
            Mesh.CreateMeshSection_LinearColor(Section, Vertices, Indices, {}, UVs, Colors, {}, false, false);
    }
};

// Only the extruded curtain is built: `Point` on the ground, `Point` lifted to
// `Lift` on top, so the ring reads as a solid 3D step and nothing else.
void AddRing(const FGeoRing &Path, FBoundarySection &Wall)
{
    const int32 Count = Path.Points.Num() - 1;
    const double Length = Path.Lengths.Last();
    for (int32 I = 0; I <= Count; ++I)
    {
        const FVector Point = Path.Points[I];
        const double U = Path.Lengths[I] / Length;
        Wall.Add(Point, FVector2D(U, 0), 0);
        Wall.Add(Point, FVector2D(U, 1), 1);
        if (I > 0)
            Wall.Connect();
    }
}
}

void AGeoMap::InitBoundaryEffects()
{
    BoundaryOff = ParseBoundaryOff();
    auto *Surface = LoadObject<UMaterialInterface>(nullptr, TEXT("/Game/Geo/M_BoundarySurface.M_BoundarySurface"));
    if (!Surface)
        return;

    BoundaryMesh = NewObject<UProceduralMeshComponent>(this);
    BoundaryMesh->SetupAttachment(RootComponent);
    BoundaryMesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);
    BoundaryMesh->SetCastShadow(false);
    BoundaryMesh->SetBoundsScale(2.f);
    BoundaryMesh->RegisterComponent();
    for (int32 Layer = 0; Layer < LayerCount; ++Layer)
    {
        auto *Material = UMaterialInstanceDynamic::Create(Surface, this);
        Material->SetScalarParameterValue(TEXT("Layer"), BoundaryMaterialLayer[Layer]);
        BoundaryLayers.Add(Material);
        BoundaryMesh->SetMaterial(Layer, Material);
    }

    auto *System = LoadObject<UNiagaraSystem>(
        nullptr, TEXT("/Niagara/DefaultAssets/Templates/Systems/MinimalLightweight.MinimalLightweight"));
    if (!System)
        return;
    for (int32 I = 0; I < 6; ++I)
    {
        auto *Spark = NewObject<UNiagaraComponent>(this);
        Spark->SetupAttachment(RootComponent);
        Spark->SetAutoActivate(false);
        Spark->SetAsset(System);
        Spark->SetAllowScalability(false);
        Spark->SetRenderingEnabled(false);
        Spark->RegisterComponent();
        BoundarySparks.Add(Spark);
    }
}

bool AGeoMap::BoundaryEffectsCompiling() const
{
    if (!HasRaisedBoundary())
        return false;
    for (const auto &Material : BoundaryLayers)
        if (Material->GetMaterial()->IsCompiling())
            return true;
#if WITH_EDITOR
    if (!BoundarySparks.IsEmpty() && BoundarySparks[0]->GetAsset()->HasOutstandingCompilationRequests(true))
        return true;
#endif
    return false;
}

void AGeoMap::UpdateBoundaryEffects(const FString &FocusId, const TArray<FString> &Visited, double BaseFocus, double Focus, double Time)
{
    BoundaryLift = 0;
    if (!BoundaryMesh)
        return;

    // Rebuilding whenever the visited set changes is what makes the tour accumulate:
    // each new village adds its plate, and nothing already painted is taken away.
    const bool VisitedChanged = BoundaryVisited != Visited;
    if (BoundaryGeneration != Generation || BoundaryFocus != FocusId || VisitedChanged)
    {
        BoundaryGeneration = Generation;
        BoundaryFocus = FocusId;
        BoundaryVisited = Visited;
        BoundaryMesh->ClearAllMeshSections();
        BoundaryPaths.Reset();
        FocusPaths.Reset();
        BoundaryHeight = 0;
        BoundaryFocusHeight = 0;
        FBox Bounds(ForceInit), FocusBounds(ForceInit);
        for (int32 I = 0; I < Rings.Num(); ++I)
        {
            const auto &Path = Rings[I];
            if (Path.Points.Num() < 4 || Path.Lengths.Last() <= 1)
                continue;
            if (Path.Parent)
            {
                BoundaryPaths.Add(I);
                for (const FVector &Point : Path.Points)
                    Bounds += Point;
            }
            else if (!FocusId.IsEmpty() && Path.Id == FocusId)
            {
                FocusPaths.Add(I);
                for (const FVector &Point : Path.Points)
                    FocusBounds += Point;
            }
        }
        BoundaryHeight = BlockHeight(Bounds);
        BoundaryFocusHeight = BlockHeight(FocusBounds);
        BoundaryWidth = BlockWidth(Bounds);
        BoundaryFocusWidth = BlockWidth(FocusBounds);
        const auto Longer = [this](int32 A, int32 B) { return Rings[A].Lengths.Last() > Rings[B].Lengths.Last(); };
        BoundaryPaths.Sort(Longer);
        FocusPaths.Sort(Longer);

        FBoundarySection Sections[LayerCount];
        const auto AddFace = [&](const FGeoFill &Fill, EBoundaryLayer Layer, const FBox &Box) {
            if (!Box.IsValid)
                return;
            const FVector Center = Box.GetCenter();
            const double Radius = FMath::Max(1., Box.GetSize().Size2D() * .5);
            const int32 Start = Sections[Layer].Vertices.Num();
            for (const FVector &Point : Fill.Vertices)
                Sections[Layer].Add(Point, FVector2D(Point - Center) / Radius, 1);
            for (const int32 Index : Fill.Indices)
                Sections[Layer].Indices.Add(Start + Index);
        };
        for (const auto &Fill : Fills)
        {
            if (Fill.Parent)
                AddFace(Fill, Face, Bounds);
            else if (Visited.Contains(Fill.Id))
                AddFace(Fill, VisitedFace, Bounds);
        }
        for (const int32 I : BoundaryPaths)
            AddRing(Rings[I], Sections[Curtain]);
        for (int32 Layer = 0; Layer < LayerCount; ++Layer)
            Sections[Layer].Create(*BoundaryMesh, Layer);
    }

    const double BaseStrength = FMath::SmoothStep(.015, .82, BaseFocus);
    const double FocusStrength = FMath::SmoothStep(.015, .82, Focus);
    // Nothing is up yet (the opening descent, or a scene before its outline is drawn):
    // keep the whole thing off so nothing z-fights with the map.
    const bool Visible = (BaseFocus > .015 && !BoundaryPaths.IsEmpty()) ||
                         (Focus > .015 && !FocusPaths.IsEmpty());
    BoundaryMesh->SetVisibility(Visible);
    for (const auto &Spark : BoundarySparks)
        Spark->SetRenderingEnabled(Visible);
    if (!Visible)
        return;

    const double BaseLift = BoundaryHeight * BaseStrength;
    // The child plates are flat: they sit a hair above the slab's top face so the
    // green paints over it instead of fighting it in the depth buffer. The reference
    // look is a filled region, not a second extrusion.
    constexpr double PlateLift = 200.;
    const bool ShowFocus = !FocusPaths.IsEmpty() && FocusStrength > .002;
    BoundaryLift = BaseLift + (ShowFocus ? PlateLift : 0.);
    const float Flow = FMath::Frac(Time * .135);
    const float Scan = FMath::Frac(Time * .225);
    const FLinearColor ParentTint(.22, .70, .18), ChildTint(.20, .76, .22);
    for (int32 Layer = 0; Layer < BoundaryLayers.Num(); ++Layer)
    {
        UMaterialInstanceDynamic *Material = BoundaryLayers[Layer];
        const bool IsChild = Layer >= VisitedFace;
        const bool Muted = (BoundaryOff & (1 << Layer)) != 0;
        const double Strength = IsChild ? BaseStrength * .80 : BaseStrength * 1.12;
        Material->SetScalarParameterValue(TEXT("Lift"), BaseLift + (IsChild ? PlateLift : 0.));
        Material->SetScalarParameterValue(TEXT("Strength"), Muted ? 0.f : float(Strength));
        Material->SetScalarParameterValue(TEXT("Flow"), Flow);
        Material->SetScalarParameterValue(TEXT("Scan"), Scan);
        Material->SetVectorParameterValue(TEXT("Tint"), IsChild ? ChildTint : ParentTint);
    }

    // Sparks ride the ring that is actually being toured.
    const bool SparkOnFocus = ShowFocus && !FocusPaths.IsEmpty();
    if (!SparkOnFocus && BoundaryPaths.IsEmpty())
        return;
    const auto &Path = SparkOnFocus ? Rings[FocusPaths[0]] : Rings[BoundaryPaths[0]];
    const double SparkWidth = SparkOnFocus ? BoundaryFocusWidth : BoundaryWidth;
    const double Length = Path.Lengths.Last();
    for (int32 I = 0; I < BoundarySparks.Num(); ++I)
    {
        auto *Spark = BoundarySparks[I].Get();
        const double Phase = FMath::Frac(1. + Flow + (I / 3) * .5 - (I % 3) * .009);
        const double Distance = Phase * Length;
        const int32 End = FMath::Clamp(Algo::UpperBound(Path.Lengths, Distance), 1, Path.Points.Num() - 1);
        const double Portion = (Distance - Path.Lengths[End - 1]) / FMath::Max(1., Path.Lengths[End] - Path.Lengths[End - 1]);
        FVector Position = FMath::Lerp(Path.Points[End - 1], Path.Points[End], Portion);
        Position.Z += BoundaryLift + SparkWidth * (.5 + (I % 3) * .85);
        Spark->SetWorldScale3D(FVector(SparkWidth / (12.5 * (1 + I % 3))));
        Spark->SetWorldLocation(Position);
        if (!Spark->IsActive())
            Spark->Activate();
    }
}
