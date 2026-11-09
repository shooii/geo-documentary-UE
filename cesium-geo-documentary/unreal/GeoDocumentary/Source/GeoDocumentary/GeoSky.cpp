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
#include "UObject/ConstructorHelpers.h"

namespace
{
    constexpr double CloudBottomKm = 1.5;
    constexpr double CloudTopKm = 3.5;
    const FLinearColor SunColor(1.f, .955f, .90f);
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
    Atmosphere->MieScatteringScale = 1.f;
    Atmosphere->MieAnisotropy = .78f;

    Clouds = CreateDefaultSubobject<UVolumetricCloudComponent>(TEXT("VolumetricCloud"));
    Clouds->SetupAttachment(RootComponent);
    Clouds->LayerBottomAltitude = CloudBottomKm;
    Clouds->LayerHeight = CloudTopKm - CloudBottomKm;
    Clouds->TracingMaxDistance = 32.f;
    Clouds->TracingStartMaxDistance = 6.f;
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
    Sun->Intensity = 8.f;
    Sun->LightColor = SunColor.ToFColor(true);
    Sun->bCastVolumetricShadow = true;
    Sun->bCastCloudShadows = true;
    Sun->DynamicShadowDistanceMovableLight = 12000.f;
    Sun->SetWorldRotation(FRotator(-38.f, 142.f, 0.f));

    SkyLight = CreateDefaultSubobject<USkyLightComponent>(TEXT("SkyLight"));
    SkyLight->SetupAttachment(RootComponent);
    SkyLight->SourceType = ESkyLightSourceType::SLS_CapturedScene;
    SkyLight->bRealTimeCapture = true;
    SkyLight->Intensity = 1.f;
    SkyLight->bLowerHemisphereIsBlack = false;
}

void AGeoVolumetricSky::ApplyRenderSettings()
{
    struct FSetting { const TCHAR *Name; float Value; };
    // Cloud quality / temporal stability. The defaults alias badly on a 30 fps
    // pixel stream, and the "washed out" look comes from sampling the sky light
    // and local lights inside the volume, so those two stay off.
    const FSetting Settings[] = {
        {TEXT("r.VolumetricCloud"), 1.f},
        {TEXT("r.VolumetricCloud.ShadowMap"), 1.f},
        {TEXT("r.VolumetricCloud.ShadowMap.MaxResolution"), 1024.f},
        {TEXT("r.VolumetricCloud.SkyAO"), 1.f},
        {TEXT("r.VolumetricCloud.SkyAO.MaxResolution"), 512.f},
        {TEXT("r.VolumetricCloud.ViewRaySampleMaxCount"), 128.f},
        {TEXT("r.VolumetricCloud.SampleMinCount"), 2.f},
        {TEXT("r.VolumetricCloud.ReflectionRaySampleMaxCount"), 12.f},
        {TEXT("r.VolumetricCloud.EmptySpaceSkipping"), 1.f},
        {TEXT("r.VolumetricCloud.AllowAnalyticDerivatives"), 1.f},
        {TEXT("r.VolumetricCloud.EnableAerialPerspectiveSampling"), 1.f},
        {TEXT("r.VolumetricCloud.EnableLocalLightsSampling"), 0.f},
        {TEXT("r.VolumetricCloud.EnableDistantSkyLightSampling"), 1.f},
        {TEXT("r.VolumetricCloud.ApplyFogLate"), 1.f},
        {TEXT("r.VolumetricRenderTarget"), 1.f},
        {TEXT("r.VolumetricRenderTarget.Mode"), 2.f},
        {TEXT("r.VolumetricRenderTarget.UpsamplingMode"), 1.f},
        {TEXT("r.VolumetricRenderTarget.Scale"), 1.f},
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

void AGeoVolumetricSky::UpdateView(const FVector &CameraLocation, const FVector &Forward, double CameraHeightMeters)
{
    CameraForward = Forward.GetSafeNormal();
    CameraAltitude = CameraHeightMeters;
    const double Bottom = GetCloudBottomMeters(), Top = GetCloudTopMeters(), Edge = 240.0;
    const double Depth = FMath::Min(CameraHeightMeters - Bottom, Top - CameraHeightMeters);
    const double Inside = FMath::Clamp(Depth / Edge, 0.0, 1.0);
    PreviousPierce = Pierce;
    Pierce = Inside;
    // Punching out of the top of the deck is the moment the shot should flare.
    if (PreviousPierce > .35 && Inside < PreviousPierce - .12)
        ExitBurst = 1.0;

    if (Mist)
    {
        const bool Active = Pierce > .02 && DeckOpacity > .05;
        if (Active != bMistActive)
        {
            bMistActive = Active;
            Mist->SetVisibility(Active);
            if (Active) Mist->Activate(true); else Mist->Deactivate();
        }
        if (Active)
        {
            const FVector Offset = CameraForward * (260.0 + 240.0 * Pierce);
            Mist->SetWorldLocation(CameraLocation + Offset);
            const double Scale = .6 + 1.4 * Pierce;
            Mist->SetWorldScale3D(FVector(Scale));
            Mist->SetVariableFloat(TEXT("User.Opacity"), (float)Pierce);
        }
    }
}

void AGeoVolumetricSky::Tick(float DeltaSeconds)
{
    Super::Tick(DeltaSeconds);
    WindTime += DeltaSeconds;
    ExitBurst = FMath::Max(0.0, ExitBurst - DeltaSeconds * .9);

    if (!CloudMaterial)
        return;
    // Wind: the simple cloud material drifts its noise with this velocity, so the
    // deck keeps moving without re-authoring the material.
    const double Drift = FMath::Fmod(WindTime * 55.0, 10000.0);
    CloudMaterial->SetVectorParameterValue(TEXT("WindVelocity"), FLinearColor(1.0, .35, 0.0, 0.0));
    CloudMaterial->SetScalarParameterValue(TEXT("WindMultiplier"), 1.0);
    CloudMaterial->SetScalarParameterValue(TEXT("Cloud_GlobalDensity"), (float)(DeckOpacity * (1.15 + .05 * FMath::Sin(Drift))));
    CloudMaterial->SetScalarParameterValue(TEXT("Cloud_GlobalCoverage"), (float)(.62 * DeckOpacity));
    CloudMaterial->SetVectorParameterValue(TEXT("Cloud_AlbedoColor"), FLinearColor(.92, .95, 1.0, 1.0));
    if (Clouds)
        Clouds->SetVisibility(DeckOpacity > .02);
}
