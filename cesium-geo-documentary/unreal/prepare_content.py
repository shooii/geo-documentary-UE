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
unreal.log('GEO_CONTENT_READY')
