import { readFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// AR 引擎来自 npm 包，不进仓库。只需要这三个文件：世界追踪用不到人脸模型等其他资源。
const XR_PKG = 'node_modules/@8thwall/engine-binary'
const XR_DIR = `${XR_PKG}/dist`
const XR_FILES = ['xr.js', 'xr-slam.js', 'LICENSE']
// 放在带版本号的目录里（/xr/1.0.0/）：文件名不变，可以放心长期缓存，升级引擎时目录跟着变，不会拿到旧缓存。
// 引擎按 xr.js 自己所在的目录去加载 xr-slam.js，所以两个文件必须在同一个目录。
const XR_VERSION = JSON.parse(readFileSync(`${XR_PKG}/package.json`, 'utf8')).version as string
const XR_BASE = `/xr/${XR_VERSION}/`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function reportEndpoint(server: any) {
  server.middlewares.use('/api/lab-report', (req: any, res: any) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end()
      return
    }
    let body = ''
    req.on('data', (chunk: unknown) => {
      body += chunk
      if (body.length > 256 * 1024) req.destroy()
    })
    req.on('end', async () => {
      try {
        const report = JSON.parse(body)
        await mkdir('probe/reports', { recursive: true })
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
        const name = `lab-${stamp}-${Math.random().toString(36).slice(2, 6)}.json`
        await writeFile(`probe/reports/${name}`, JSON.stringify(report, null, 2))
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true, file: name }))
      } catch {
        res.statusCode = 400
        res.end()
      }
    })
  })
}

// 测试版（?debug）“发送结果”时附带的一张 AR 画面截图，存进 probe/reports/shots/（不进仓库）。只在本机的开发、预览服务器上有。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function shotEndpoint(server: any) {
  server.middlewares.use('/api/lab-shot', (req: any, res: any) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 4 * 1024 * 1024) req.destroy()
      else chunks.push(chunk)
    })
    req.on('end', async () => {
      const body = Buffer.concat(chunks)
      // 只收 JPEG
      if (body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8) {
        res.statusCode = 400
        res.end()
        return
      }
      await mkdir('probe/reports/shots', { recursive: true })
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const name = `shot-${stamp}-${Math.random().toString(36).slice(2, 6)}.jpg`
      await writeFile(`probe/reports/shots/${name}`, body)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true, file: name }))
    })
  })
}

// 测试功能（?debug：帧率、诊断数据、截图发回电脑）只在开发服务器和测试构建（--mode lab）里有。
// 正式构建里 __LAB__ 是 false，这些代码在打包时整段去掉，正式网站不会尝试上传任何东西。
export default defineConfig(({ command, mode }) => {
  const lab = command === 'serve' || mode === 'lab'
  return {
  define: {
    __LAB__: JSON.stringify(lab),
    __XR_BASE__: JSON.stringify(XR_BASE),
    // 测试版显示的版本（构建时间），手机上一眼能看出是不是最新版
    __BUILD__: JSON.stringify(new Date().toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })),
  },
  plugins: [
    react(),
    {
      // 把引擎放到 /xr/<版本>/：开发时直接提供，构建时复制进 dist。
      name: 'xr-engine',
      configureServer(server) {
        server.middlewares.use(XR_BASE, async (req, res, next) => {
          const name = (req.url ?? '').split('?')[0].replace(/^\//, '')
          if (!XR_FILES.includes(name)) return next()
          res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/plain; charset=utf-8')
          res.setHeader('Cache-Control', 'max-age=3600') // 手机调试时不用每次重新下载
          res.end(await readFile(`${XR_DIR}/${name}`))
        })
      },
      async closeBundle() {
        await mkdir(`dist${XR_BASE}`, { recursive: true })
        await Promise.all(XR_FILES.map((f) => copyFile(`${XR_DIR}/${f}`, `dist${XR_BASE}${f}`)))
      },
    },
    {
      // 真机测试把帧率发回电脑，存进 probe/reports/（不进仓库）。只在本机的开发服务器和测试版的预览服务器上有，正式部署没有。
      name: 'lab-report',
      configureServer: (server) => {
        reportEndpoint(server)
        shotEndpoint(server)
      },
      configurePreviewServer: (server) => {
        if (!lab) return
        reportEndpoint(server)
        shotEndpoint(server)
      },
    },
  ],
  // three.js 单独在相机页的包里，约 140 KB（gzip），属于预期大小。
  build: { chunkSizeWarningLimit: 800 },
  server: {
    // 真机测试走 cloudflared 临时隧道（https://….trycloudflare.com）。
    allowedHosts: ['.trycloudflare.com'],
  },
  // 手机测试走预览（正式构建）：开发服务器在手机切后台时连接会断，回来后会自动刷新页面，测不出真实表现。
  preview: {
    allowedHosts: ['.trycloudflare.com'],
  },
  }
})
