using UnrealBuildTool;
public class GeoDocumentaryEditorTarget : TargetRules { public GeoDocumentaryEditorTarget(TargetInfo Target) : base(Target) { Type = TargetType.Editor; DefaultBuildSettings = BuildSettingsVersion.V6; ExtraModuleNames.Add("GeoDocumentary"); } }
