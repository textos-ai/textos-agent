export const AGENT_NAME_POOL = [
  'Atlas', 'Pilot', 'Compass', 'Ranger', 'Scout', 'Aero',
  'Iris', 'Echo', 'Nova', 'Vega', 'Luna', 'Nyx',
  'Phoenix', 'Onyx', 'Ember', 'Zephyr', 'Cipher', 'Orion',
  'Sable', 'Halo', 'Forge', 'Tempo', 'Quill', 'Vale',
];

export function pickRandomAgentName(): string {
  return AGENT_NAME_POOL[Math.floor(Math.random() * AGENT_NAME_POOL.length)];
}
