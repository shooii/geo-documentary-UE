import unreal
path = '/Game/Geo/M_Tile'
material = unreal.load_asset(path)
if material is None:
    material = unreal.AssetToolsHelpers.get_asset_tools().create_asset('M_Tile', '/Game/Geo', unreal.Material, unreal.MaterialFactoryNew())
    material.set_editor_property('shading_model', unreal.MaterialShadingModel.MSM_UNLIT)
    material.set_editor_property('two_sided', True)
    texture = unreal.MaterialEditingLibrary.create_material_expression(material, unreal.MaterialExpressionTextureSampleParameter2D, -350, 0)
    texture.set_editor_property('parameter_name', 'Imagery')
    texture.set_editor_property('texture', unreal.load_asset('/Engine/EngineResources/DefaultTexture'))
    unreal.MaterialEditingLibrary.connect_material_property(texture, 'RGB', unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    unreal.MaterialEditingLibrary.recompile_material(material)
unreal.EditorAssetLibrary.save_loaded_asset(material)

# 天地图注记层（`cia`）是带 alpha 的透明 PNG：影像材质 `M_Tile` 是不透明 unlit，
# 直接复用会把每张注记瓦片画成一块灰板。这里单独建一个半透明材质，颜色走
# Emissive、透明度取贴图 alpha，网格叠在影像上方 40 m，不遮挡底图。
OVERLAY = '/Game/Geo/M_TileOverlay'
overlay = unreal.load_asset(OVERLAY)
if overlay is None:
    tools = unreal.AssetToolsHelpers.get_asset_tools()
    overlay = tools.create_asset('M_TileOverlay', '/Game/Geo', unreal.Material, unreal.MaterialFactoryNew())
    overlay.set_editor_property('shading_model', unreal.MaterialShadingModel.MSM_UNLIT)
    overlay.set_editor_property('two_sided', True)
    overlay.set_editor_property('blend_mode', unreal.BlendMode.BLEND_TRANSLUCENT)
    editor = unreal.MaterialEditingLibrary
    sample = editor.create_material_expression(overlay, unreal.MaterialExpressionTextureSampleParameter2D, -420, 0)
    sample.set_editor_property('parameter_name', 'Imagery')
    sample.set_editor_property('texture', unreal.load_asset('/Engine/EngineResources/DefaultTexture'))
    multiply = editor.create_material_expression(overlay, unreal.MaterialExpressionMultiply, -180, 60)
    if not editor.connect_material_expressions(sample, 'RGB', multiply, 'A'):
        raise RuntimeError('Cannot connect M_TileOverlay RGB')
    # 注记是纯白描边字，乘 1.15 让它在压暗后的暗底图上仍然清楚。
    multiply.set_editor_property('const_b', 1.15)
    if not editor.connect_material_property(multiply, '', unreal.MaterialProperty.MP_EMISSIVE_COLOR):
        raise RuntimeError('Cannot connect M_TileOverlay emissive')
    if not editor.connect_material_property(sample, 'A', unreal.MaterialProperty.MP_OPACITY):
        raise RuntimeError('Cannot connect M_TileOverlay opacity')
    editor.recompile_material(overlay)
    unreal.EditorAssetLibrary.save_loaded_asset(overlay)


def prepare_boundary_material(name, blend_mode, opacity_code):
    material = unreal.load_asset('/Game/Geo/' + name)
    if material is not None:
        return
    tools = unreal.AssetToolsHelpers.get_asset_tools()
    material = tools.create_asset(name, '/Game/Geo', unreal.Material, unreal.MaterialFactoryNew())
    material.set_editor_property('shading_model', unreal.MaterialShadingModel.MSM_UNLIT)
    material.set_editor_property('two_sided', True)
    material.set_editor_property('blend_mode', blend_mode)
    editor = unreal.MaterialEditingLibrary

    def node(kind, x, y, **properties):
        expression = editor.create_material_expression(material, kind, x, y)
        for key, value in properties.items():
            expression.set_editor_property(key, value)
        return expression

    def custom(code, output_type, y, **sources):
        inputs = []
        for key in sources:
            entry = unreal.CustomInput()
            entry.set_editor_property('input_name', key)
            inputs.append(entry)
        expression = node(unreal.MaterialExpressionCustom, -280, y, code=code, output_type=output_type, inputs=inputs)
        for key, (source, output) in sources.items():
            if not editor.connect_material_expressions(source, output, expression, key):
                raise RuntimeError(f'Cannot connect {name}.{key}')
        return expression

    uv = node(unreal.MaterialExpressionTextureCoordinate, -680, -110)
    color = node(unreal.MaterialExpressionVertexColor, -680, 380)
    tint = node(unreal.MaterialExpressionVectorParameter, -680, -420,
                parameter_name='Tint', default_value=unreal.LinearColor(0.12, 0.73, 1.0, 1.0))
    parameters = {key: node(unreal.MaterialExpressionScalarParameter, -930, index * 100,
                            parameter_name=key, default_value=0.0)
                  for index, key in enumerate(('Layer', 'Strength', 'Flow', 'Scan', 'Lift'))}
    surface = blend_mode == unreal.BlendMode.BLEND_TRANSLUCENT
    opacity = custom(opacity_code, unreal.CustomMaterialOutputType.CMOT_FLOAT1, 20,
                     UV=(uv, ''), Layer=(parameters['Layer'], ''), Strength=(parameters['Strength'], ''),
                     **({'Scan': (parameters['Scan'], '')} if surface else {'Flow': (parameters['Flow'], '')}))
    emissive_code = ('return Tint * (Layer < 0.5 ? 0.87 : 1.65);' if surface else
                     'return lerp(Tint * 1.6, float3(4.0, 3.8, 3.4), Layer < 2.5 ? 0.7 : 0.18);')
    emissive = custom(emissive_code, unreal.CustomMaterialOutputType.CMOT_FLOAT3, -300,
                      Tint=(tint, ''), Layer=(parameters['Layer'], ''))
    lift = custom('return float3(0, 0, Weight * Lift);', unreal.CustomMaterialOutputType.CMOT_FLOAT3, 400,
                  Weight=(color, 'A'), Lift=(parameters['Lift'], ''))
    for expression, prop in ((opacity, unreal.MaterialProperty.MP_OPACITY),
                             (emissive, unreal.MaterialProperty.MP_EMISSIVE_COLOR),
                             (lift, unreal.MaterialProperty.MP_WORLD_POSITION_OFFSET)):
        if not editor.connect_material_property(expression, '', prop):
            raise RuntimeError(f'Cannot connect {name} to {prop}')
    editor.recompile_material(material)
    unreal.EditorAssetLibrary.save_loaded_asset(material)


prepare_boundary_material('M_BoundarySurface', unreal.BlendMode.BLEND_TRANSLUCENT, """
if (Layer < 0.5) {
    float radius = length(UV);
    float head = Scan * 1.23;
    float distance = head - radius;
    float pulse = smoothstep(-0.025, 0.005, distance) * (1 - smoothstep(0.02, 0.15, distance));
    float fade = smoothstep(0.01, 0.14, head) * (1 - smoothstep(0.85, 1.23, head));
    return Strength * (0.13 + 0.25 * pulse * fade);
}
return Strength * 0.47 * pow(saturate(UV.y), 1.65);
""")

prepare_boundary_material('M_BoundaryLight', unreal.BlendMode.BLEND_ADDITIVE, """
float edge = saturate(1 - abs(UV.y * 2 - 1));
float distance = frac((Flow - UV.x) * 2 + 1);
float trail = 1 - smoothstep(0, 0.18, distance);
if (Layer < 2.5)
    return Strength * pow(edge, 0.7) * (0.32 + trail * 0.62);
return Strength * pow(edge, 3.5) * (0.11 + trail * 0.48);
""")

# --- 穿云水汽：Niagara ------------------------------------------------
# 复制引擎自带的轻量粒子系统作为水汽基底，挂到天空 Actor 上，穿云时按穿透
# 深度缩放 / 淡入。工程内资源优先，引擎模板兜底。
MIST = '/Game/Geo/NS_CloudMist'
if not unreal.EditorAssetLibrary.does_asset_exist(MIST):
    source = unreal.load_asset('/Niagara/DefaultAssets/Templates/Systems/MinimalLightweight')
    if source:
        duplicated = unreal.AssetToolsHelpers.get_asset_tools().duplicate_asset(
            'NS_CloudMist', '/Game/Geo', source)
        if duplicated:
            unreal.EditorAssetLibrary.save_loaded_asset(duplicated)
            unreal.log('GEO_CLOUD_MIST_READY')

unreal.log('GEO_CONTENT_READY')
