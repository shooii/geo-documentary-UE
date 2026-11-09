#include "GeoSky.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/VolumetricCloudComponent.h"
#include "Components/DirectionalLightComponent.h"
#include "Components/SkyLightComponent.h"
#include "Components/SceneComponent.h"
#include "Materials/MaterialInterface.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "NiagaraComponent.h"
#include "NiagaraSystem.h"
#include "HAL/IConsoleManager.h"
#include "HAL/PlatformMisc.h"
#include "UObject/ConstructorHelpers.h"

namespace
{
    constexpr double CloudBottomKm = 1.5;
    constexpr double CloudTopKm = 3.5;
    // Slightly cool sun cancels the warm cast that the 27 km atmospheric path adds.
    const FLinearColor SunColor(.95f, .98f, 1.f);

    // m_SimpleVolumetricCloud defaults, read from the material itself. The previous
    // code drove Cloud_GlobalDensity to 1.15 -- 140x the shipped 0.008 -- and
    // Cloud_GlobalCoverage to 0.62 against a shipped -0.20, which filled the whole sky
    // with an opaque white sheet. That was the "cloud pierce looks washed out" bug.
    constexpr float CloudDensityDefault = .008f;
    constexpr float CloudCoverageDefault = -.20f;
    // (octave1, octave2, octave3, strength) of the material's multiple scattering.
    const FLinearColor MultiScatterDefault(.6667f, .25f, .18f, 1.f);
}

AGeoVolumetricSky::AGeoVolumetricSky()
{
    PrimaryActorTick.bCanEverTick = true;
    RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));

    Atmosphere = CreateDefaultSubobject<USkyAtmosphereComponent>(TEXT("SkyAtmosphere"));
    Atmosphere->SetupAttachment(RootComponent);
    Atmosphere->TransformMode = ESkyAtmosphereTransformMode::PlanetTopAtAbsoluteWorldOrigin;
    Atmosphere->BottomRadius = 6420.f;
    Atmosphere->AtmosphereHeight = 60.f;
    Atmosphere->RayleighScatteringScale = 1.f;
    Atmosphere->MieScatteringScale = .25f;
    Atmosphere->MieAnisotropy = .55f;
    // The map camera sits ~25 km up and looks straight down, so a physically correct
    // aerial perspective turns the imagery into a flat haze. Keep the sky, drop the
    // distance fog: the map has to stay readable.
    Atmosphere->AerialPespectiveViewDistanceScale = 0.f;

    Clouds = CreateDefaultSubobject<UVolumetricCloudComponent>(TEXT("VolumetricCloud"));
    Clouds->SetupAttachment(RootComponent);
    Clouds->LayerBottomAltitude = CloudBottomKm;
    Clouds->LayerHeight = CloudTopKm - CloudBottomKm;
    // Tracing range, in km. TracingStartMaxDistance is where the march is allowed to
    // begin, not where it stops: at 6 the deck 21 km below a 25 km camera was never
    // reached and no cloud was drawn at all. 350 is the engine default and covers the
    // whole map range; TracingMaxDistance caps how far past that start we keep sampling.
    Clouds->TracingMaxDistance = 32.f;
    Clouds->TracingStartMaxDistance = 350.f;
    Clouds->bUsePerSampleAtmosphericLightTransmittance = true;
    Clouds->ViewSampleCountScale = 1.f;
    Clouds->ReflectionViewSampleCountScaleValue = .35f;
    Clouds->ShadowViewSampleCountScale = .7f;
    Clouds->ShadowReflectionViewSampleCountScaleValue = .35f;
    Clouds->PlanetRadius = 6420.f;
    static ConstructorHelpers::FObjectFinder<UMaterialInterface> CloudMaterialAsset(
        TEXT("/Engine/EngineSky/VolumetricClouds/m_SimpleVolumetricCloud_Inst.m_SimpleVolumetricCloud_Inst"));
    if (CloudMaterialAsset.Succeeded())
        Clouds->SetMaterial(CloudMaterialAsset.Object);

    Sun = CreateDefaultSubobject<UDirectionalLightComponent>(TEXT("Sun"));
    Sun->SetupAttachment(RootComponent);
    Sun->SetMobility(EComponentMobility::Movable);
    Sun->bAtmosphereSunLight = true;
    Sun->AtmosphereSunLightIndex = 0;
    Sun->Intensity = 150.f;
    Sun->LightColor = SunColor.ToFColor(true);
    Sun->bCastVolumetricShadow = true;
    Sun->bCastCloudShadows = true;
    Sun->DynamicShadowDistanceMovableLight = 12000.f;
    Sun->SetWorldRotation(FRotator(-62.f, 142.f, 0.f));

    SkyLight = CreateDefaultSubobject<USkyLightComponent>(TEXT("SkyLight"));
    SkyLight->SetupAttachment(RootComponent);
    SkyLight->SourceType = ESkyLightSourceType::SLS_CapturedScene;
    SkyLight->bRealTimeCapture = true;
    SkyLight->Intensity = .3f;
    // The deck sits 1.5-3.5 km up with a warm satellite basemap underneath it. Sampling
    // the lower hemisphere fed that brown ground bounce straight into the clouds and
    // turned them orange, so the ambient term only comes from the sky above.
    SkyLight->bLowerHemisphereIsBlack = true;
}

void AGeoVolumetricSky::ApplyRenderSettings()
{
    struct FSetting { const TCHAR *Name; float Value; };
    // Cloud quality / temporal stability. The defaults alias badly on a 30 fps
    // pixel stream, and the "washed out" look comes from sampling the sky light
    // and local lights inside the volume, so those two stay off.
    const FSetting Settings[] = {
        {TEXT("r.VolumetricCloud"), 1.f},
        {TEXT("r.VolumetricCloud.Support"), 1.f},
        {TEXT("r.VolumetricCloud.ShadowMap"), 1.f},
        {TEXT("r.VolumetricCloud.ShadowMap.MaxResolution"), 1024.f},
        // Spatial filtering smooths the shadow term instead of leaving stair steps on it.
        {TEXT("r.VolumetricCloud.ShadowMap.SpatialFiltering"), 1.f},
        {TEXT("r.VolumetricCloud.Shadow.ViewRaySampleMaxCount"), 32.f},
        {TEXT("r.VolumetricCloud.ShadowMap.RaySampleMaxCount"), 64.f},
        {TEXT("r.VolumetricCloud.SkyAO"), 1.f},
        {TEXT("r.VolumetricCloud.SkyAO.MaxResolution"), 512.f},
        {TEXT("r.VolumetricCloud.SkyAO.TraceSampleCount"), 16.f},
        {TEXT("r.VolumetricCloud.ViewRaySampleMaxCount"), 128.f},
        // Sampled from the material defaults upward: the camera physically enters the
        // deck during a pierce, so the near-field samples carry the whole look.
        {TEXT("r.VolumetricCloud.SampleMinCount"), 4.f},
        // Distribute the ray samples evenly over 20 km. Too short and the far half of the
        // deck bandses; too long and the near field loses the resolution it needs.
        {TEXT("r.VolumetricCloud.DistanceToSampleMaxCount"), 20.f},
        // 1 = no shortcut through empty space, which is what removes the banding that
        // shows up as stair steps on a fast-moving camera.
        {TEXT("r.VolumetricCloud.StepSizeOnZeroConservativeDensity"), 1.f},
        {TEXT("r.VolumetricCloud.ReflectionRaySampleMaxCount"), 12.f},
        {TEXT("r.VolumetricCloud.EmptySpaceSkipping"), 1.f},
        {TEXT("r.VolumetricCloud.AllowAnalyticDerivatives"), 1.f},
        // The camera looks down through ~27 km of atmosphere. With aerial perspective on,
        // that path tints the deck orange the same way it washed the imagery out before,
        // so the cloud layer opts out of it just like SkyAtmosphere did.
        {TEXT("r.VolumetricCloud.EnableAerialPerspectiveSampling"), 0.f},
        {TEXT("r.VolumetricCloud.EnableAtmosphericLightsSampling"), 0.f},
        // Local lights inside the volume are what push the deck towards flat white.
        {TEXT("r.VolumetricCloud.EnableLocalLightsSampling"), 0.f},
        {TEXT("r.VolumetricCloud.EnableDistantSkyLightSampling"), 1.f},
        {TEXT("r.VolumetricCloud.ApplyFogLate"), 1.f},
        {TEXT("r.VolumetricRenderTarget"), 1.f},
        // Keep the composite mode the ini asks for. Mode 2 routes the deck through the
        // experimental separate-target path, which is what turned the whole frame into
        // a flat dark plate on this build.
        {TEXT("r.VolumetricRenderTarget.Mode"), 1.f},
        {TEXT("r.VolumetricRenderTarget.UpsamplingMode"), 1.f},
        {TEXT("r.VolumetricRenderTarget.Scale"), 1.f},
        // A fast pierce breaks temporal reprojection and smears the deck. Only reproject
        // once the cloud surface is far enough away for the previous frame to still be
        // valid.
        {TEXT("r.VolumetricRenderTarget.MinimumDistanceKmToEnableReprojection"), 6.f},
    };
    for (const FSetting &Setting : Settings)
        if (auto *Variable = IConsoleManager::Get().FindConsoleVariable(Setting.Name))
            Variable->Set(Setting.Value, ECVF_SetByCode);
}

void AGeoVolumetricSky::BeginPlay()
{
    Super::BeginPlay();
    ApplyRenderSettings();
    if (Clouds)
    {
        if (auto *Base = Clouds->GetMaterial())
        {
            CloudMaterial = UMaterialInstanceDynamic::Create(Base, this);
            Clouds->SetMaterial(CloudMaterial);
            ApplyCloudMaterial();
        }
    }

    UNiagaraSystem *System = LoadObject<UNiagaraSystem>(
        nullptr, TEXT("/Game/Geo/NS_CloudMist.NS_CloudMist"));
    if (!System)
        System = LoadObject<UNiagaraSystem>(
            nullptr, TEXT("/Niagara/DefaultAssets/Templates/Systems/MinimalLightweight.MinimalLightweight"));
    if (System)
    {
        Mist = NewObject<UNiagaraComponent>(this, TEXT("CloudMist"));
        Mist->SetupAttachment(RootComponent);
        Mist->SetAsset(System);
        Mist->bAutoActivate = false;
        Mist->SetVisibility(false);
        Mist->RegisterComponent();
    }
}

bool AGeoVolumetricSky::HasCloudDeck() const
{
    return Clouds != nullptr && Clouds->GetMaterial() != nullptr;
}

double AGeoVolumetricSky::GetCloudBottomMeters() const { return CloudBottomKm * 1000.0; }
double AGeoVolumetricSky::GetCloudTopMeters() const { return CloudTopKm * 1000.0; }

void AGeoVolumetricSky::SetDeckOpacity(double Opacity)
{
    DeckOpacity = FMath::Clamp(Opacity, 0.0, 1.0);
}

void AGeoVolumetricSky::SetWind(const FVector2D &Direction, double SpeedKmh)
{
    if (!Direction.IsNearlyZero())
        WindDirection = Direction.GetSafeNormal();
    WindSpeedKmh = FMath::Clamp(SpeedKmh, 0.0, 400.0);
}

void AGeoVolumetricSky::SetMultiScattering(double Strength)
{
    MultiScatter = FMath::Clamp(Strength, 0.0, 2.0);
}

void AGeoVolumetricSky::UpdateView(const FVector &InCameraLocation, const FVector &Forward,
                                   double CameraHeightMeters, double ScriptedPierce)
{
    CameraForward = Forward.GetSafeNormal();
    CameraLocation = InCameraLocation;
    CameraAltitude = CameraHeightMeters;
    const double Bottom = GetCloudBottomMeters(), Top = GetCloudTopMeters(), Edge = 240.0;
    const double Depth = FMath::Min(CameraHeightMeters - Bottom, Top - CameraHeightMeters);
    const double Inside = FMath::Clamp(Depth / Edge, 0.0, 1.0);
    PreviousPierce = Pierce;
    Pierce = FMath::Clamp(FMath::Max(Inside, ScriptedPierce), 0.0, 1.0);
    // Punching out of the deck is the moment the shot should flare. The graded pierce
    // falls away over ~16 frames, so a single-frame threshold of .12 never fired; the
    // drop is accumulated instead and decays in Tick.
    const double Drop = PreviousPierce - Pierce;
    if (Drop > 0 && PreviousPierce > .3)
        ExitBurst = FMath::Min(1.0, ExitBurst + Drop * 4.0);
    RefreshMist();
}

void AGeoVolumetricSky::RefreshMist()
{
    if (!Mist)
        return;
    const bool Active = Pierce > .02 && DeckOpacity > .05;
    if (Active != bMistActive)
    {
        bMistActive = Active;
        Mist->SetVisibility(Active);
        if (Active)
            Mist->Activate(true);
        else
            Mist->Deactivate();
    }
    if (!Active)
        return;

    // Park the system ahead of the camera so the sprites wrap around the lens rather
    // than sitting on it, and grow it with the pierce depth so the mist thickens in the
    // middle of the deck.
    const FVector Offset = CameraForward * (220.0 + 320.0 * Pierce) +
                           FVector(0, 0, 90.0 * FMath::Sin(MistPhase * .7));
    Mist->SetWorldLocation(CameraLocation + Offset);
    const double Scale = .7 + 1.8 * Pierce;
    Mist->SetWorldScale3D(FVector(Scale));

    // These are best-effort: NS_CloudMist ships as a MinimalLightweight copy that exposes
    // none of them, and Niagara silently ignores unknown user parameters. They exist so
    // a properly authored mist system drops straight in without touching C++.
    const float Fade = float(Pierce * DeckOpacity);
    Mist->SetVariableFloat(TEXT("User.Opacity"), Fade);
    Mist->SetVariableFloat(TEXT("User.SpawnRate"), 60.f + 240.f * Fade);
    Mist->SetVariableFloat(TEXT("User.Size"), 90.f + 260.f * Fade);
    Mist->SetVariableVec3(TEXT("User.Wind"), FVector(WindDirection.X, WindDirection.Y, 0.05) * (WindSpeedKmh * 14.0));
    Mist->SetVariableLinearColor(TEXT("User.Tint"),
                                 FLinearColor(.86f, .93f, 1.f, 1.f) * (.55f + .45f * Fade));
}

void AGeoVolumetricSky::ApplyCloudMaterial()
{
    if (!CloudMaterial)
        return;
    const float Deck = float(DeckOpacity);
    const float Depth = float(Pierce);
    // Density and coverage come from the material's own defaults and scale up towards a
    // pierce, never past a few times the shipped value. The deck has to read as cloud
    // from inside without turning into a white wall.
    const float Density = FMath::Lerp(CloudDensityDefault * 8.f, CloudDensityDefault * 16.f, Depth) * Deck;
    const float Coverage = FMath::Lerp(CloudCoverageDefault + .06f, CloudCoverageDefault + .24f, Depth) * Deck;
    CloudMaterial->SetScalarParameterValue(TEXT("Cloud_GlobalDensity"), Density);
    CloudMaterial->SetScalarParameterValue(TEXT("Cloud_GlobalCoverage"), Coverage);

    // Multiple scattering. There is no r.VolumetricCloud.MultiScattering in this engine
    // build; the octave weights live on the cloud material as Multiscatter_Controls.
    const float M = float(MultiScatter);
    CloudMaterial->SetVectorParameterValue(
        TEXT("Multiscatter_Controls"),
        FLinearColor(MultiScatterDefault.R * M, MultiScatterDefault.G * M, MultiScatterDefault.B * M,
                     MultiScatterDefault.A));

    // Wind. The material reads Layout_WindControls, not WindVelocity -- the previous
    // WindVelocity/WindMultiplier writes matched no parameter and did nothing at all.
    const double Speed = WindSpeedKmh / 55.0;
    CloudMaterial->SetVectorParameterValue(
        TEXT("Layout_WindControls"),
        FLinearColor(float(WindDirection.X * Speed), float(WindDirection.Y * Speed), .5f, .3333f));

    CloudMaterial->SetVectorParameterValue(TEXT("Cloud_AlbedoColor"), FLinearColor(.97f, .975f, 1.f, .5f));

    static int32 CloudReport = 0;
    if (++CloudReport % 90 == 0)
        UE_LOG(LogTemp, Display,
               TEXT("GEO_CLOUD deck=%.2f pierce=%.2f density=%.4f coverage=%.3f visible=%d "
                    "bottom=%.1f height=%.1f cam=%.1fkm"),
               DeckOpacity, Pierce, Density, Coverage, Clouds && Clouds->IsVisible() ? 1 : 0,
               Clouds ? Clouds->LayerBottomAltitude : -1.f, Clouds ? Clouds->LayerHeight : -1.f,
               CameraAltitude / 1000.0);
}

void AGeoVolumetricSky::Tick(float DeltaSeconds)
{
    Super::Tick(DeltaSeconds);
    WindTime += DeltaSeconds;
    MistPhase += DeltaSeconds;
    ExitBurst = FMath::Max(0.0, ExitBurst - DeltaSeconds * .9);
    ApplyCloudMaterial();
    if (Clouds)
        Clouds->SetVisibility(DeckOpacity > .02);
}
