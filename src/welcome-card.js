import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WELCOME_CARD_PATH = fileURLToPath(new URL('../assets/nexadesk-welcome-thanks.png', import.meta.url));

let cachedWelcomeCard = null;

export function createWelcomeCard() {
  cachedWelcomeCard ??= readFileSync(WELCOME_CARD_PATH);
  return cachedWelcomeCard;
}
