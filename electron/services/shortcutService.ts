import { app } from 'electron'
import { spawn } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'

export class ShortcutService {
    /**
     * 更新桌面快捷方式的图标
     * 注意：这需要调用 PowerShell，可能会短暂显示控制台窗口或被杀毒软件拦截
     * @param iconPath ICO 图标文件的绝对路径
     */
    async updateDesktopShortcutIcon(iconPath: string): Promise<{ success: boolean; error?: string }> {
        return new Promise((resolve) => {
            try {
                if (!existsSync(iconPath)) {
                    resolve({ success: false, error: '图标文件不存在' })
                    return
                }

                const desktopPath = app.getPath('desktop')
                const exePath = process.execPath

                // PowerShell 脚本：遍历桌面所有 .lnk，如果目标指向当前 exe，则修改图标
                // 使用 -WindowStyle Hidden 隐藏窗口
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

                let output = ''
                let errorOutput = ''

                ps.stdout.on('data', (data) => {
                    output += data.toString()
                })

                ps.stderr.on('data', (data) => {
                    errorOutput += data.toString()
                })

                ps.on('close', (code) => {
                    if (code === 0) {
                        resolve({ success: true })
                    } else {
                        console.error('[ShortcutService] 更新快捷方式失败', errorOutput)
                        resolve({ success: false, error: errorOutput || 'Unknown PowerShell error' })
                    }
                })
            } catch (e) {
                console.error('[ShortcutService] 执行出错', e)
                resolve({ success: false, error: String(e) })
            }
        })
    }
}

export const shortcutService = new ShortcutService()
