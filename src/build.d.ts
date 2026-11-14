/** 构建时间，见 vite.config.ts */
declare const __BUILD__: string
/** 测试功能是否打包进来（开发服务器和 --mode lab 的测试构建为 true，正式构建为 false），见 vite.config.ts */
declare const __LAB__: boolean
/** AR 引擎所在的目录（带版本号，如 /xr/1.0.0/），见 vite.config.ts */
declare const __XR_BASE__: string
