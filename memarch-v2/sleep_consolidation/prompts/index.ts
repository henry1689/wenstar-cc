/**
 * MemArch-v2.0.0 / M3-SleepConsolidation / prompts/index
 */

export {
  GIST_SYSTEM_PROMPT,
  buildGistUserPrompt,
  parseGistResult,
  type GistResult,
} from './gist.prompt.js';

export {
  SALIENCE_SYSTEM_PROMPT,
  buildSalienceUserPrompt,
  parseSalienceResult,
  type SalienceScore,
} from './salience.prompt.js';

export {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionUserPrompt,
  parseExtractionResult,
  type ExtractedFact,
} from './extraction.prompt.js';
