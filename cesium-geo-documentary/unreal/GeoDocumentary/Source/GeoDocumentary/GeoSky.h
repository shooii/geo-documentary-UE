#pragma once
#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "GeoSky.generated.h"

class USkyAtmosphereComponent;
class UVolumetricCloudComponent;
class UDirectionalLightComponent;
class USkyLightComponent;
class UMaterialInstanceDynamic;
class UNiagaraComponent;

/**
 * Native UE5 sky for the map renderer: SkyAtmosphere + VolumetricCloud + DirectionalLight.
 * The cloud deck sits between 1.5 km and 3.5 km, drifts with wind, and reports a
 * 0..1 "pierce" factor so the owning map can animate exposure, bloom and mist.
 */
UCLASS()
class AGeoVolumetricSky : public AActor
{
    GENERATED_BODY()
public:
    AGeoVolumetricSky();
    virtual void BeginPlay() override;
    virtual void Tick(float DeltaSeconds) override;

    /**
     * Camera pose for this frame, in world space.
     * @param ScriptedPierce 0..1 from the shot data (`clouds.volume`). The opening pass
     *        keeps the camera above the deck, so the graded pierce beat has to come from
     *        the shot as well as from the camera's physical altitude inside the layer.
     */
    void UpdateView(const FVector &CameraLocation, const FVector &Forward, double CameraHeightMeters,
                    double ScriptedPierce = 0.0);
    /** Deck opacity 0..1 (0 hides the layer entirely). */
    void SetDeckOpacity(double Opacity);
    /** Wind at deck altitude. Direction is XY in world space, speed in km/h. */
    void SetWind(const FVector2D &Direction, double SpeedKmh);
    /** Multi-scattering strength, 0..2. 1 keeps the material defaults. */
    void SetMultiScattering(double Strength);
    double GetCloudBottomMeters() const;
    double GetCloudTopMeters() const;
    double GetPierce() const { return Pierce; }
    double GetDeckOpacity() const { return DeckOpacity; }
    double GetExitBurst() const { return ExitBurst; }
    double GetCameraAltitude() const { return CameraAltitude; }
    bool HasCloudDeck() const;

    UPROPERTY() TObjectPtr<USkyAtmosphereComponent> Atmosphere;
    UPROPERTY() TObjectPtr<UVolumetricCloudComponent> Clouds;
    UPROPERTY() TObjectPtr<UDirectionalLightComponent> Sun;
    UPROPERTY() TObjectPtr<USkyLightComponent> SkyLight;
    UPROPERTY() TObjectPtr<UMaterialInstanceDynamic> CloudMaterial;
    UPROPERTY() TObjectPtr<UNiagaraComponent> Mist;

private:
    void ApplyRenderSettings();
    void ApplyCloudMaterial();
    void RefreshMist();

    // Starts hidden: the deck only shows while a shot asks for cloud (the opening
    // fly-through). Left at 1 it becomes a permanent overcast between the camera and
    // the map, which is exactly what hid the imagery.
    double DeckOpacity = 0, Pierce = 0, ExitBurst = 0, CameraAltitude = 12000, WindTime = 0;
    double PreviousPierce = 0;
    // Wind and multi-scattering are material parameters, not console variables: this
    // engine build exposes no r.VolumetricCloud.MultiScattering.
    FVector2D WindDirection = FVector2D(1.0, 0.35);
    double WindSpeedKmh = 55.0;
    double MultiScatter = 1.0;
    FVector CameraForward = FVector::ForwardVector;
    FVector CameraLocation = FVector::ZeroVector;
    bool bMistActive = false;
    double MistPhase = 0;
};
