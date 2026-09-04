import assert from 'node:assert/strict';
import { LocalSupportClient, sanitizePublicSupportReply } from '../src/ai/local-support-client.js';

const client = new LocalSupportClient();

const cases = [
  {
    name: 'understands phonetic Spanish water question',
    input: 'Xke el añua eña moñada',
    expected: 'agua'
  },
  {
    name: 'understands phonetic Spanish sun question',
    input: 'I shi ell ñol el amawillo volque ilumina tango',
    expected: 'Sol'
  },
  {
    name: 'answers safe multi-question message',
    input: '¿Por qué el cielo es azul? ¿Cuántas patas tiene una araña? ¿2+2?',
    expected: '2 + 2 es 4'
  },
  {
    name: 'adapts to age without requesting personal data',
    input: 'Tengo chinco anos komo ga esgo?',
    expected: 'forma sencilla'
  },
  {
    name: 'routes web malfunction away from user report',
    input: 'No es de un usuario, sino de un mal funcionamiento de la web.',
    expected: 'no es un reporte contra un usuario'
  },
  {
    name: 'keeps incomplete report intake flexible',
    input: 'Me gustaría reportar un caso de',
    expected: 'usuario o sobre un fallo'
  },
  {
    name: 'does not turn signoff containing error into incident',
    input: 'Vale, pues nada, no pasa nada, NexaDesk, gracias por este error ticket.',
    expected: 'De nada'
  }
];

for (const testCase of cases) {
  const output = await client.generate({ messages: [{ role: 'user', content: testCase.input }] });
  assert.match(output, new RegExp(testCase.expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), testCase.name);
  assert.doesNotMatch(output, /Sigo contigo|no tengo un hecho concreto|dato nuevo|la señal aporta|owner o staff/i, testCase.name);
}

const channelContext = [
  'Mapa real de canales:',
  'Canal real del servidor: <#100000000000000001> (nombre visible: #🤝〢Alliance (📃〢Rules)).',
  'Mencion exacta para Discord: <#100000000000000001>.',
  'Canal real del servidor: <#100000000000000002> (nombre visible: #👋〢Bienvenidas).',
  'Mencion exacta para Discord: <#100000000000000002>.'
].join('\n');

const rulesReply = await client.generate({
  system: channelContext,
  messages: [{ role: 'user', content: 'Hola, donde puedo ver las normas?' }]
});
assert.match(rulesReply, /<#100000000000000001>/i);
assert.doesNotMatch(rulesReply, /<#100000000000000002>|welcome|bienvenida/i);

const welcomeReply = await client.generate({
  system: channelContext,
  messages: [
    { role: 'user', content: 'Hola, donde puedo ver las normas?' },
    { role: 'assistant', content: 'Puedes consultar las normas en <#100000000000000001>.' },
    { role: 'user', content: 'Donde puedo ver las bienvenidas?' }
  ]
});
assert.match(welcomeReply, /<#100000000000000002>/i);
assert.doesNotMatch(welcomeReply, /<#100000000000000001>|#(?:welcome|bienvenida|soporte)\b/i);

const noWelcomeReply = await client.generate({
  system: channelContext.split('\n').filter((line) => !line.includes('100000000000000002')).join('\n'),
  messages: [{ role: 'user', content: 'Donde puedo ver las bienvenidas?' }]
});
assert.match(noWelcomeReply, /No he localizado un canal publico de Discord/i);
assert.doesNotMatch(noWelcomeReply, /<#100000000000000001>|#(?:welcome|bienvenida|soporte)\b/i);

const leaked = 'He entendido el dato nuevo: el ultimo mensaje contiene este error. La señal aporta un fallo concreto. La respuesta debe partir de ese dato.';
const sanitized = sanitizePublicSupportReply({
  answer: leaked,
  latestText: cases.at(-1).input,
  language: 'es'
});
assert.match(sanitized, /De nada/i);
assert.doesNotMatch(sanitized, /dato nuevo|señal aporta|respuesta debe/i);

console.log(`AI transcript regressions passed: ${cases.length + 4}`);
