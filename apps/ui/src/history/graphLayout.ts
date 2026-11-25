export interface LayoutCommit {
  sha: string;
  parents: string[];
}

export interface Segment {
  from: number;
  to: number;
  color: number;
}

export interface GraphRow {
  lane: number;
  color: number;
  up: Segment[];
  down: Segment[];
}

export interface GraphLayout {
  rows: GraphRow[];
  laneCount: number;
}

export function computeGraphLayout(commits: LayoutCommit[], paletteSize: number): GraphLayout {
  const lanes: (string | null)[] = [];
  const laneColors: number[] = [];
  const rows: GraphRow[] = [];
  const palette = Math.max(1, paletteSize);
  let nextColor = 0;
  let laneCount = 0;

  const newColor = (): number => nextColor++ % palette;

  const freeLane = (): number => {
    const free = lanes.indexOf(null);
    if (free !== -1) return free;
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    const before = lanes.slice();
    const waiting: number[] = [];
    before.forEach((sha, k) => {
      if (sha === commit.sha) waiting.push(k);
    });

    let nodeLane: number;
    if (waiting.length === 0) {
      nodeLane = freeLane();
      laneColors[nodeLane] = newColor();
    } else {
      nodeLane = waiting[0];
    }
    const nodeColor = laneColors[nodeLane];
    laneCount = Math.max(laneCount, lanes.length);

    const up: Segment[] = [];
    before.forEach((sha, k) => {
      if (sha === null) return;
      up.push({ from: k, to: sha === commit.sha ? nodeLane : k, color: laneColors[k] });
    });

    const released = new Set<number>(waiting.filter((k) => k !== nodeLane));
    for (const k of released) lanes[k] = null;

    lanes[nodeLane] = commit.parents.length > 0 ? commit.parents[0] : null;

    const targets = new Set<number>();
    commit.parents.forEach((parent, index) => {
      if (index === 0) {
        targets.add(nodeLane);
        return;
      }
      let target = lanes.indexOf(parent);
      if (target === -1) {
        target = freeLane();
        lanes[target] = parent;
        laneColors[target] = newColor();
      }
      targets.add(target);
    });

    const down: Segment[] = [];
    before.forEach((sha, k) => {
      if (sha === null || k === nodeLane || released.has(k)) return;
      down.push({ from: k, to: k, color: laneColors[k] });
    });
    for (const target of targets) {
      down.push({ from: nodeLane, to: target, color: laneColors[target] });
    }
    down.sort((a, b) => a.to - b.to || Number(a.from !== a.to) - Number(b.from !== b.to));

    laneCount = Math.max(laneCount, lanes.length);
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    rows.push({ lane: nodeLane, color: nodeColor, up, down });
  }

  return { rows, laneCount };
}
