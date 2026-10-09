// Bounded offline host for the same processor and WAV encoder used by the dashboard.
import fs from 'node:fs';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const [mode, configPath] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (mode === 'validate') {
  const validator = await import(pathToFileURL(config.validator));
  const result = config.kind === 'record'
    ? validator.validateMatterRecord(config.value)
    : config.kind === 'receipt'
      ? validator.validateOperationReceipt(config.value)
      : validator.validateDocument('processingRequest', config.value);
  process.stdout.write(JSON.stringify(result));
  process.exit(result.valid ? 0 : 2);
}
if (mode !== 'render') throw new Error('unsupported engine mode');
const source = fs.readFileSync(new URL('../dashboard/static/audio_engine.js', import.meta.url), 'utf8');
const { WORKLET_SOURCE, encodeWavBlob } = await import(
  'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
);
let seed = config.seed >>> 0;
const seededMath = Object.create(Math);
seededMath.random = () => {
  seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
  return seed / 4294967296;
};
let Processor;
const context = vm.createContext({
  Math: seededMath, Float32Array, sampleRate: config.sampleRate,
  AudioWorkletProcessor: class { constructor() { this.port = {}; } },
  registerProcessor(name, cls) { if (name === 'germ-granular') Processor = cls; },
});
vm.runInContext(WORKLET_SOURCE, context, { timeout: 1000 });
const engine = new Processor({ processorOptions: config.params });
const pcm = fs.readFileSync(config.input);
const channels = config.channels;
const frames = pcm.length / (channels * 2);
const output = Array.from({ length: channels }, () => new Float32Array(frames));
for (let start = 0; start < frames; start += 128) {
  const count = Math.min(128, frames - start);
  const input = Array.from({ length: channels }, (_, c) => {
    const block = new Float32Array(count);
    for (let i = 0; i < count; i++) block[i] = pcm.readInt16LE(((start + i) * channels + c) * 2) / 32768;
    return block;
  });
  engine.process([input], [output.map(channel => channel.subarray(start, start + count))]);
}
if (output.some(channel => channel.some(value => !Number.isFinite(value)))) {
  throw new Error('non-finite engine output');
}
const blob = encodeWavBlob(output, config.sampleRate, { bitDepth: 16, dither: false });
fs.writeFileSync(config.output, Buffer.from(await blob.arrayBuffer()), { flag: 'wx' });
