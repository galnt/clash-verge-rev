import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const triples = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
}

const key = `${process.platform}-${process.arch}`
const triple = triples[key]
if (!triple) {
  throw new Error(`Unsupported platform for the speed test core: ${key}`)
}

const suffix = process.platform === 'win32' ? '.exe' : ''
const output = path.join(
  root,
  'src-tauri',
  'sidecar',
  `verge-throne-core-${triple}${suffix}`,
)

// 与 Throne 自己的 core 构建保持一致（Throne script/build_go.sh 的 windows 分支），
// 这样可用的协议面与 Throne 完全相同：uTLS 供 Reality、QUIC 供 Hysteria2/TUIC。
const tags = [
  'with_clash_api',
  'with_quic',
  'with_wireguard',
  'with_utls',
  'with_dhcp',
  'with_tailscale',
  'with_openvpn',
  'with_openconnect',
  'with_naive_outbound',
  'badlinkname',
  'tfogo_checklinkname0',
  // core 启动时会校验父进程必须是 Throne.exe；noparentcheck 是上游自带的构建开关，
  // 打开后本应用才能直接把它作为子进程拉起（core 源码零改动）。
  'noparentcheck',
]

if (process.platform === 'win32') {
  tags.push('with_purego')
}

const env = { ...process.env }
// Throne 在 windows 上用静态构建，macOS/Linux 需要 cgo 才能编 tun 相关代码。
env.CGO_ENABLED = process.platform === 'win32' ? '0' : '1'

fs.mkdirSync(path.dirname(output), { recursive: true })
execFileSync(
  'go',
  [
    '-C',
    path.join(root, 'core'),
    'build',
    '-tags',
    tags.join(','),
    '-ldflags',
    '-w -s -checklinkname=0',
    '-o',
    output,
    '.',
  ],
  { stdio: 'inherit', env },
)
console.log(`Built ${output}`)
