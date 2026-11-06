# 快速开始

## 环境

- Node.js 24、pnpm 11、Google Chrome
- Python 3（GIS 脚本需要 Shapely）
- 依赖已锁定在 `pnpm-lock.yaml` 与 `requirements.txt`

```powershell
pnpm install
python -m pip install -r requirements.txt
pnpm geo-video doctor
```

## 构建单个地区

```powershell
pnpm geo-video validate-data --region 440802
pnpm capture -- --region 440802 --profile landscape --encode
pnpm geo-video compose --region 440802 --profile landscape
pnpm typecheck
pnpm test
```

HyperFrames 预览：

```powershell
Set-Location apps/video-compositor
npx hyperframes preview --port 3017
```

预览确认后执行草稿或高质量批量渲染：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/render-profile.ps1 -Profile landscape -Quality draft
powershell -ExecutionPolicy Bypass -File scripts/render-profile.ps1 -Profile landscape -Quality high
```

验证输出：

```powershell
pnpm exec tsx .agents/skills/cesium-geo-documentary/scripts/validate-delivery.ts --stage final
```
