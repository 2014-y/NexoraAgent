const text = process.argv[2] || '这是渠道回复朗读链路测试。';
const source = process.argv[3] || 'channel';
const res = await fetch('http://127.0.0.1:18791/voice/speak', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text, source })
});
console.log(res.status, await res.text());
