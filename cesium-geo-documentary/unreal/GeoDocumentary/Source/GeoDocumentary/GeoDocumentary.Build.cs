using UnrealBuildTool;
public class GeoDocumentary : ModuleRules { public GeoDocumentary(ReadOnlyTargetRules Target) : base(Target) { PCHUsage=PCHUsageMode.UseExplicitOrSharedPCHs; PublicDependencyModuleNames.AddRange(new[]{"Core","CoreUObject","Engine","InputCore","Json","HTTP","ImageWrapper","ProceduralMeshComponent","RenderCore","RHI"}); } }
