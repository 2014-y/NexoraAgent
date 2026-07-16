const https = require('https');

function httpsGetJson(url) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 8000
        };
        https.get(url, options, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`请求失败，状态码: ${res.statusCode}`));
                return;
            }
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', (err) => reject(err))
          .on('timeout', function() {
              this.destroy();
              reject(new Error('请求超时'));
          });
    });
}

function getLatestVersionFromRedirect(url) {
    const urlModule = require('url');
    return new Promise((resolve, reject) => {
        const parsedUrl = urlModule.parse(url);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.path,
            method: 'HEAD',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 8000
        };
        const req = https.request(options, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                const location = res.headers.location;
                const match = location.match(/\/releases\/tag\/(v?[0-9a-zA-Z.-]+)/);
                if (match) {
                    resolve(match[1]);
                } else {
                    reject(new Error('未在重定向目标中找到版本号'));
                }
            } else {
                reject(new Error(`请求未发生重定向，状态码: ${res.statusCode}`));
            }
        });
        req.on('error', (err) => reject(err));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('请求超时'));
        });
        req.end();
    });
}

async function test() {
    const repoUrl = 'https://api.github.com/repos/2014-y/Nexora-Agent/releases/latest';
    const redirectUrl = 'https://github.com/2014-y/Nexora-Agent/releases/latest';
    console.log('Testing API...');
    try {
        const data = await httpsGetJson(repoUrl);
        console.log('API success:', data.tag_name);
    } catch (e) {
        console.log('API failed:', e.message);
        console.log('Testing Redirect...');
        try {
            const tag = await getLatestVersionFromRedirect(redirectUrl);
            console.log('Redirect success:', tag);
        } catch (re) {
            console.log('Redirect failed:', re.message);
        }
    }
}

test();
