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

    /** Camera pose for this frame, in world space. */
    void UpdateView(const FVector &CameraLocation, const FVector &Forward, double CameraHeightMeters);
    /** Deck opacity 0..1 (0 hides the layer entirely). */
    void SetDeckOpacity(double Opacity);
    double GetCloudBottomMeters() const;
    double GetCloudTopMeters() const;
    double GetPierce() const { return Pierce; }
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
    void RefreshMist();

    double DeckOpacity = 1, Pierce = 0, ExitBurst = 0, CameraAltitude = 12000, WindTime = 0;
    double PreviousPierce = 0;
    FVector CameraForward = FVector::ForwardVector;
    bool bMistActive = false;
};
