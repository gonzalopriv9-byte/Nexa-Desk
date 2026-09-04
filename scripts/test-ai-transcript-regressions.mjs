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

const leaked = 'He entendido el dato nuevo: el ultimo mensaje contiene este error. La señal aporta un fallo concreto. La respuesta debe partir de ese dato.';
const sanitized = sanitizePublicSupportReply({
  answer: leaked,
  latestText: cases.at(-1).input,
  language: 'es'
});
assert.match(sanitized, /De nada/i);
assert.doesNotMatch(sanitized, /dato nuevo|señal aporta|respuesta debe/i);

console.log(`AI transcript regressions passed: ${cases.length + 1}`);
