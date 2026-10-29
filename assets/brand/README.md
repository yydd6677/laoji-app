# 应用标识

`visionary-mark.svg` 是可编辑源文件。标识使用两条交叠的直边笔画，主体外接范围为1:1：

- 深蓝：`#305978`
- 青色：`#4098A9`

`node tools/generate-brand-assets.cjs` 可在Linux或Windows生成启动图、桌面图标、adaptive/monochrome图标和favicon。生成PNG作为构建输入随源码保存；常规构建无需重新栅格化。

Android adaptive前景位于66/108安全圆内。启动页底部署名为 `created by visionary tech`，使用系统200×80dp branding区域，不增加强制停留时间。字体沿用项目字体资源。
