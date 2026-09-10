import { useEffect, useState } from "react";

const WORDS = [
  "Cogitating",
  "Pondering",
  "Ruminating",
  "Deliberating",
  "Contemplating",
  "Reasoning",
  "Synthesizing",
  "Mulling"
];

const CYCLE_MS = 2200;

function pickStart(): number {
  return Math.floor(Math.random() * WORDS.length);
}

export function useWorkingWord(active: boolean): string {
  const [index, setIndex] = useState(pickStart);
  useEffect(() => {
    if (!active) return;
    setIndex(pickStart());
    const timer = window.setInterval(() => setIndex((v) => (v + 1) % WORDS.length), CYCLE_MS);
    return () => window.clearInterval(timer);
  }, [active]);
  return WORDS[index];
}

export function WorkingPill({ word }: { word: string }) {
  return (
    <span className="working-pill">
      <span className="pulse" />
      {word}…
    </span>
  );
}
