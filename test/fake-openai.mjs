// Provedor falso compatível com OpenAI, para testar o OpenCode sem credenciais.
// 1ª resposta: chama a ferramenta bash. Depois: responde com texto final.
import { createServer } from 'node:http';
const port = Number(process.env.PORT || 0);
const srv = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const j = body ? JSON.parse(body) : {};
  if (!req.url.includes('chat/completions')) { res.writeHead(404).end(); return; }
  const msgs = j.messages || [];
  const hasTool = msgs.some((m) => m.role === 'tool');
  const wantsTitle = JSON.stringify(msgs).includes('title') && !j.tools?.length;
  const id = 'c' + Date.now();
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: j.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const usage = `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: j.model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (wantsTitle) {
    res.write(chunk({ role: 'assistant', content: 'Teste' }));
    res.write(chunk({}, 'stop'));
  } else if (!hasTool && j.tools?.length) {
    // O comando pode vir na tarefa: "CMD: <comando>".
    const userText = JSON.stringify(msgs.filter((m) => m.role === 'user'));
    const fromTask = /CMD: ([^"\\]+)/.exec(userText)?.[1];
    const cmd = fromTask || process.env.FAKE_CMD || 'echo oi-do-agente';
    await new Promise((r) => setTimeout(r, 700)); // simula o modelo pensando
    res.write(chunk({ role: 'assistant', content: 'Vou rodar um comando.' }));
    res.write(chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: cmd, description: 'teste' }) } }] }));
    res.write(chunk({}, 'tool_calls'));
  } else {
    res.write(chunk({ role: 'assistant', content: 'Pronto: o comando rodou.' }));
    res.write(chunk({}, 'stop'));
  }
  res.write(usage);
  res.end('data: [DONE]\n\n');
});
srv.listen(port, '127.0.0.1', () => console.log(srv.address().port));
