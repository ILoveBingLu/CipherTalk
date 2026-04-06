const { parentPort, workerData } = require('worker_threads')
const path = require('path')
const fs = require('fs')
const koffi = require('koffi')

// 从 workerData 获取原生库路径
const { nativeLibPath } = workerData

if (!nativeLibPath || !fs.existsSync(nativeLibPath)) {
    parentPort?.postMessage({ type: 'error', error: 'Native library path not found: ' + nativeLibPath })
    process.exit(1)
}

try {
    // 加载原生库
    const lib = koffi.load(nativeLibPath)

    // 定义回调类型
    const ProgressCallback = koffi.proto('void ProgressCallback(int current, int total)')

    // 绑定函数 (这里使用同步版本，因为 Worker 本身就是独立的线程)
    const Wcdb_DecryptDatabaseWithProgress = lib.func('int Wcdb_DecryptDatabaseWithProgress(const char* inputPath, const char* outputPath, const char* hexKey, ProgressCallback* callback)')
    const Wcdb_GetLastErrorMsg = lib.func('int Wcdb_GetLastErrorMsg(char* buffer, int size)')

    // 监听主线程消息
    parentPort?.on('message', (message) => {
        if (message.type === 'decrypt') {
            const { id, inputPath, outputPath, hexKey } = message

            try {
                // 确保输出目录存在
                const outputDir = path.dirname(outputPath)
                if (!fs.existsSync(outputDir)) {
                    fs.mkdirSync(outputDir, { recursive: true })
                }

                // 定义进度回调 (带节流，每 100ms 更新一次)
                let lastUpdate = 0

                const onProgress = koffi.register((current, total) => {
                    const now = Date.now()
                    if (now - lastUpdate > 100 || current === total || current === 1) {
                        lastUpdate = now
                        parentPort?.postMessage({
                            type: 'progress',
                            id,
                            current,
                            total
                        })
                    }
                }, koffi.pointer(ProgressCallback))

                // 执行解密
                const result = Wcdb_DecryptDatabaseWithProgress(inputPath, outputPath, hexKey, onProgress)

                // 注销回调以释放资源
                koffi.unregister(onProgress)

                if (result === 0) {
                    parentPort?.postMessage({ type: 'success', id })
                } else {
                    // 获取错误信息
                    const buffer = Buffer.alloc(512)
                    Wcdb_GetLastErrorMsg(buffer, 512)
                    const errorMsg = buffer.toString('utf8').replace(/\0+$/, '')

                    parentPort?.postMessage({
                        type: 'error',
                        id,
                        error: errorMsg || `ErrorCode: ${result}`
                    })
                }
            } catch (err) {
                parentPort?.postMessage({
                    type: 'error',
                    id,
                    error: String(err)
                })
            }
        }
    })

    // 通知主线程 Worker 已就绪
    parentPort?.postMessage({ type: 'ready' })

} catch (err) {
    parentPort?.postMessage({ type: 'error', error: String(err) })
}
