/**
 * 仅开发用：电脑上通过 cloudflared 隧道打开时，显示手机要扫的二维码，省得在手机上输入长地址。
 * 二维码库来自 probe/public/vendor（不进仓库，也不进正式构建）。
 */
export function showDevQr(path: string, title: string) {
  if (/iPhone|iPad|Android/.test(navigator.userAgent) || !location.hostname.endsWith('.trycloudflare.com')) return
  const s = document.createElement('script')
  s.src = '/probe/public/vendor/qrcode.js'
  s.onload = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qr = (window as any).qrcode(0, 'M')
    qr.addData(location.origin + path)
    qr.make()
    const box = document.createElement('div')
    box.setAttribute(
      'style',
      'position:fixed;right:12px;top:12px;z-index:50;width:210px;padding:12px;border-radius:14px;background:#fff;color:#1f2a44;' +
        'display:flex;flex-direction:column;gap:6px;align-items:center;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.25);font-size:13px',
    )
    box.innerHTML = `<b>${title}</b>${qr.createSvgTag(4, 2).replace('<svg ', '<svg style="width:186px;height:186px" ')}<small>iPhone 相机扫码；点这里关闭</small>`
    box.addEventListener('click', () => box.remove())
    document.body.append(box)
  }
  document.head.append(s)
}
