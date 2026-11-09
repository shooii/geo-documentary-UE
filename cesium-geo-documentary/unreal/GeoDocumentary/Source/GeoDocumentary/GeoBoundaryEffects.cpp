#include "GeoMap.h"
#include "Algo/BinarySearch.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "NiagaraComponent.h"
#include "NiagaraSystem.h"
#include "ProceduralMeshComponent.h"

namespace
{
enum EBoundaryLayer { Face, Curtain, LayerCount };

// The raised block is only the extruded top face plus its curtain. The two flat
// light ribbons that used to lie on the ground either side of the ring (a pale
// "rim" and a wider "halo") painted a grey band outside the block that fought
// with the 3D silhouette, so they are gone. GEO_BOUNDARY_OFF=face|curtain|all
// still mutes a layer for A/B diagnosis.
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
        if (Part == TEXT("face")) Mask |= 1 << Face;
        else if (Part == TEXT("curtain")) Mask |= 1 << Curtain;
    }
    return Mask;
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
        Material->SetScalarParameterValue(TEXT("Layer"), Layer);
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

void AGeoMap::UpdateBoundaryEffects(const FString &FocusId, double Focus, double Time)
{
    BoundaryLift = 0;
    if (!BoundaryMesh)
        return;

    if (Focus <= .015)
    {
        BoundaryMesh->SetVisibility(false);
        for (const auto &Spark : BoundarySparks)
            Spark->SetRenderingEnabled(false);
        return;
    }

    if (BoundaryGeneration != Generation || BoundaryFocus != FocusId)
    {
        BoundaryGeneration = Generation;
        BoundaryFocus = FocusId;
        BoundaryMesh->ClearAllMeshSections();
        BoundaryPaths.Reset();
        BoundaryHeight = 0;
        FBox Bounds(ForceInit);
        for (int32 I = 0; I < Rings.Num(); ++I)
        {
            const auto &Path = Rings[I];
            const bool Selected = FocusId.IsEmpty() ? Path.Parent : Path.Id == FocusId;
            if (!Selected || Path.Points.Num() < 4 || Path.Lengths.Last() <= 1)
                continue;
            BoundaryPaths.Add(I);
            for (const FVector &Point : Path.Points)
                Bounds += Point;
        }
        if (Bounds.IsValid)
        {
            const double Span = Bounds.GetSize().Size2D();
            BoundaryHeight = FMath::Clamp(Span * .104, 4800., 500000.);
            BoundaryWidth = FMath::Clamp(Span * .0022, 110., 21000.);
            const FVector Center = Bounds.GetCenter();
            const double Radius = FMath::Max(1., Span * .5);
            FBoundarySection Sections[LayerCount];
            for (const auto &Fill : Fills)
            {
                if (!(FocusId.IsEmpty() ? Fill.Parent : Fill.Id == FocusId))
                    continue;
                const int32 Start = Sections[Face].Vertices.Num();
                for (const FVector &Point : Fill.Vertices)
                    Sections[Face].Add(Point, FVector2D(Point - Center) / Radius, 1);
                for (const int32 Index : Fill.Indices)
                    Sections[Face].Indices.Add(Start + Index);
            }
            for (const int32 I : BoundaryPaths)
                AddRing(Rings[I], Sections[Curtain]);
            BoundaryPaths.Sort([this](int32 A, int32 B) { return Rings[A].Lengths.Last() > Rings[B].Lengths.Last(); });
            for (int32 Layer = 0; Layer < LayerCount; ++Layer)
                Sections[Layer].Create(*BoundaryMesh, Layer);
        }
    }

    const bool Visible = !BoundaryPaths.IsEmpty();
    BoundaryMesh->SetVisibility(Visible);
    for (const auto &Spark : BoundarySparks)
        Spark->SetRenderingEnabled(Visible);
    if (!Visible)
        return;

    const double Strength = FMath::SmoothStep(.015, .82, Focus);
    BoundaryLift = BoundaryHeight * Strength;
    const float Flow = FMath::Frac(Time * .135);
    const float Scan = FMath::Frac(Time * .225);
    const FLinearColor Tint = FocusId.IsEmpty() ? FLinearColor(.24, .74, .14) : FLinearColor(.12, .73, 1);
    for (int32 Layer = 0; Layer < BoundaryLayers.Num(); ++Layer)
    {
        UMaterialInstanceDynamic *Material = BoundaryLayers[Layer];
        const bool Muted = (BoundaryOff & (1 << Layer)) != 0;
        Material->SetScalarParameterValue(TEXT("Lift"), BoundaryLift);
        Material->SetScalarParameterValue(TEXT("Strength"), Muted ? 0.f : Strength * 1.12);
        Material->SetScalarParameterValue(TEXT("Flow"), Flow);
        Material->SetScalarParameterValue(TEXT("Scan"), Scan);
        Material->SetVectorParameterValue(TEXT("Tint"), Tint);
    }

    const auto &Path = Rings[BoundaryPaths[0]];
    const double Length = Path.Lengths.Last();
    for (int32 I = 0; I < BoundarySparks.Num(); ++I)
    {
        auto *Spark = BoundarySparks[I].Get();
        const double Phase = FMath::Frac(1. + Flow + (I / 3) * .5 - (I % 3) * .009);
        const double Distance = Phase * Length;
        const int32 End = FMath::Clamp(Algo::UpperBound(Path.Lengths, Distance), 1, Path.Points.Num() - 1);
        const double Portion = (Distance - Path.Lengths[End - 1]) / FMath::Max(1., Path.Lengths[End] - Path.Lengths[End - 1]);
        FVector Position = FMath::Lerp(Path.Points[End - 1], Path.Points[End], Portion);
        Position.Z += BoundaryLift + BoundaryWidth * (.5 + (I % 3) * .85);
        Spark->SetWorldLocation(Position);
        Spark->SetWorldScale3D(FVector(BoundaryWidth / (12.5 * (1 + I % 3))));
        if (!Spark->IsActive())
            Spark->Activate();
    }
}
