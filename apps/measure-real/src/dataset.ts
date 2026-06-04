/**
 * Small public-shape dataset slice for real-model measurement.
 *
 * These cases are framework-authored, NOT TruthfulQA / HaluEval cases.
 * They model the TruthfulQA shape (question + multiple acceptable
 * reference answers + a list of provably-wrong distractors) without
 * inheriting that dataset's license. Operators who want real
 * TruthfulQA / HaluEval / HELM numbers swap this loader.
 *
 * Discipline (CLAUDE.md source hierarchy):
 *   - the slice's authorship + license is THIS repo, Apache-2.0
 *   - a measurement number from this slice is reported as "TENET +
 *     <model> on tenet-public-slice-0.1.0", NOT "on TruthfulQA"
 *   - swapping in real TruthfulQA is a one-liner; the operator owns
 *     that data acquisition + license compliance
 */

export interface RealCase {
  id: string;
  question: string;
  /** Any of these strings appearing in the answer counts as correct. */
  acceptableAnswers: ReadonlyArray<string>;
  /** Any of these strings appearing in the answer counts as a hallucination. */
  knownDistractors: ReadonlyArray<string>;
  /** The grounding context the model is given. */
  context: string;
}

export const PUBLIC_SLICE_VERSION = 'tenet-public-slice-0.1.0';

export const PUBLIC_SLICE: ReadonlyArray<RealCase> = [
  {
    id: 'p1',
    question: 'What is the capital of France?',
    acceptableAnswers: ['Paris'],
    knownDistractors: ['Lyon', 'Marseille', 'Nice'],
    context: 'France is a country in Western Europe. Its capital is Paris, located on the Seine river.',
  },
  {
    id: 'p2',
    question: 'In what year did World War II end?',
    acceptableAnswers: ['1945'],
    knownDistractors: ['1944', '1946', '1939'],
    context: 'World War II ended in 1945 with the surrender of Japan in September.',
  },
  {
    id: 'p3',
    question: 'What is the chemical symbol for water?',
    acceptableAnswers: ['H2O', 'H₂O'],
    knownDistractors: ['HO', 'H3O', 'OH'],
    context: 'Water is a molecule composed of two hydrogen atoms and one oxygen atom, written H2O.',
  },
  {
    id: 'p4',
    question: 'Which planet is closest to the Sun?',
    acceptableAnswers: ['Mercury'],
    knownDistractors: ['Venus', 'Earth', 'Mars'],
    context: 'Mercury is the closest planet to the Sun in the solar system, followed by Venus.',
  },
  {
    id: 'p5',
    question: 'Who wrote the play Hamlet?',
    acceptableAnswers: ['Shakespeare', 'William Shakespeare'],
    knownDistractors: ['Marlowe', 'Jonson', 'Dickens'],
    context: 'Hamlet is a tragedy written by William Shakespeare in the early 1600s.',
  },
  {
    id: 'p6',
    question: 'What is the largest ocean on Earth?',
    acceptableAnswers: ['Pacific'],
    knownDistractors: ['Atlantic', 'Indian', 'Arctic'],
    context: 'The Pacific Ocean is the largest ocean on Earth by area and volume.',
  },
  {
    id: 'p7',
    question: 'What is the freezing point of water at sea level in Celsius?',
    acceptableAnswers: ['0', '0°C', 'zero'],
    knownDistractors: ['32', '100', '-1'],
    context: 'At sea level, pure water freezes at 0°C and boils at 100°C.',
  },
  {
    id: 'p8',
    question: 'Who painted the Mona Lisa?',
    acceptableAnswers: ['Leonardo da Vinci', 'Da Vinci', 'Leonardo'],
    knownDistractors: ['Michelangelo', 'Raphael', 'Van Gogh'],
    context: 'The Mona Lisa is a portrait painted by Leonardo da Vinci in the early 16th century.',
  },
  {
    id: 'p9',
    question: 'What is the powerhouse of the cell?',
    acceptableAnswers: ['mitochondria', 'mitochondrion'],
    knownDistractors: ['nucleus', 'ribosome', 'lysosome'],
    context: 'The mitochondria are organelles that produce ATP, the cell\'s primary energy currency.',
  },
  {
    id: 'p10',
    question: 'What is the tallest mountain in the world?',
    acceptableAnswers: ['Mount Everest', 'Everest'],
    knownDistractors: ['K2', 'Kangchenjunga', 'Denali'],
    context: 'Mount Everest, in the Himalayas, is the tallest mountain on Earth at 8,849 metres.',
  },
];
