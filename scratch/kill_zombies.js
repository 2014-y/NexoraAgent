const { execSync } = require('child_process');

try {
    console.log('Scanning for leftover Nexora Agent / openclaw Node.js processes safely...');
    
    let output = '';
    try {
        // 使用绝对无错的简单 powershell 捕获 node 进程列表
        output = execSync('powershell -ExecutionPolicy Bypass -NoProfile -Command "try { Get-Process -Name node -ErrorAction SilentlyContinue | ForEach-Object { Write-Output ($_.Id.ToString() + \':::\' + $_.Path) } } catch {}"', { encoding: 'utf8' });
    } catch(e) {
        console.error('Failed to query node processes:', e.message);
    }

    if (output) {
        const lines = output.split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            const parts = line.split(':::');
            const pid = parts[0] ? parts[0].trim() : '';
            const path = parts[1] ? parts[1].trim() : '';
            
            // 只要路径里包含了 Nexora Agent、openclaw、或者 sandbox 相关的 node，且不是我们当前的运行进程 PID
            const lowerPath = path.toLowerCase();
            const currentPid = process.pid.toString();
            
            if (pid && pid !== currentPid && ((lowerPath.includes('nexora agent') || lowerPath.includes('nexoraagent')) || lowerPath.includes('openclaw') || lowerPath.includes('node-sandbox'))) {
                console.log(`Found zombie process: PID ${pid}, Path: ${path}`);
                try {
                    execSync(`taskkill /pid ${pid} /f /t`);
                    console.log(`Successfully killed PID ${pid}`);
                } catch(err) {
                    console.error(`Failed to kill PID ${pid}:`, err.message);
                }
            }
        }
    }

    // 强杀所有 Nexora Agent.exe 残留进程 (防止客户端主进程僵尸挂起)
    console.log('Scanning for Nexora Agent.exe zombie processes...');
    try {
        const tasklist = execSync('tasklist', { encoding: 'utf8' }).toLowerCase();
        if (tasklist.toLowerCase().includes('nexora agent.exe')) {
            execSync('taskkill /f /im Nexora Agent.exe');
            console.log('Successfully killed all Nexora Agent.exe instances.');
        }
    } catch(err) {
        console.warn('No active Nexora Agent.exe or failed to kill:', err.message);
    }

    console.log('\n--- Zombie Check Done ---');
} catch (globalErr) {
    console.error('Global error in zombie killer:', globalErr.message);
}
