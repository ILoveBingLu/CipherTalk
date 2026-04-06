import { app } from 'electron'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import type { ShortcutService, ShortcutUpdateResult } from './shortcutService'

class WindowsShortcutService implements ShortcutService {
  async updateDesktopShortcutIcon(iconPath: string): Promise<ShortcutUpdateResult> {
    return new Promise((resolve) => {
      try {
        if (!existsSync(iconPath)) {
          resolve({ success: false, error: '图标文件不存在' })
          return
        }

        const desktopPath = app.getPath('desktop')
        const exePath = process.execPath
        const psScript = `
          $WshShell = New-Object -comObject WScript.Shell
          $DesktopPath = "${desktopPath}"
          $TargetExe = "${exePath}"
          $IconPath = "${iconPath}"

          Get-ChildItem -Path $DesktopPath -Filter *.lnk | ForEach-Object {
            try {
              $Shortcut = $WshShell.CreateShortcut($_.FullName)
              if ($Shortcut.TargetPath -eq $TargetExe) {
                $Shortcut.IconLocation = $IconPath
                $Shortcut.Save()
                Write-Host "Updated: $($_.Name)"
              }
            } catch {
              Write-Error $_.Exception.Message
            }
          }
        `

        const ps = spawn('powershell.exe', [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-WindowStyle', 'Hidden',
          '-Command', psScript
        ])

        let errorOutput = ''

        ps.stderr.on('data', (data) => {
          errorOutput += data.toString()
        })

        ps.on('error', (error) => {
          console.error('[ShortcutService] PowerShell 启动失败', error)
          resolve({ success: false, error: String(error) })
        })

        ps.on('close', (code) => {
          if (code === 0) {
            resolve({ success: true })
            return
          }

          console.error('[ShortcutService] 更新快捷方式失败', errorOutput)
          resolve({ success: false, error: errorOutput || 'Unknown PowerShell error' })
        })
      } catch (e) {
        console.error('[ShortcutService] 执行出错', e)
        resolve({ success: false, error: String(e) })
      }
    })
  }
}

export const shortcutService = new WindowsShortcutService()
