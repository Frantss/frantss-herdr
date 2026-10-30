export interface GraphNode {
  hash: string;
  parents: string[];
}
export interface GraphSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: number;
}
export interface GraphLayout {
  cols: number[];
  colors: number[];
  segments: GraphSegment[];
  lanes: number;
}

export function layoutGraph(nodes: GraphNode[]): GraphLayout {
  const rowOf = new Map(nodes.map((node, row) => [node.hash, row]));
  const lanes: (string | null)[] = [];
  const laneColors: number[] = [];
  const cols: number[] = [];
  const colors: number[] = [];
  const edges: { row: number; col: number; parent: string; lane: number; color: number }[] = [];
  let nextColor = 0;
  const freeLane = () => {
    const lane = lanes.indexOf(null);
    return lane < 0 ? lanes.length : lane;
  };
  nodes.forEach((node, row) => {
    let col = lanes.indexOf(node.hash);
    if (col < 0) {
      col = freeLane();
      laneColors[col] = nextColor++;
    }
    cols.push(col);
    colors.push(laneColors[col]);
    lanes.forEach((hash, lane) => {
      if (hash === node.hash) lanes[lane] = null;
    });
    lanes[col] = null;
    node.parents.forEach((parent, index) => {
      let lane = lanes.indexOf(parent);
      if (lane < 0) {
        lane = index === 0 ? col : freeLane();
        if (lane !== col) laneColors[lane] = nextColor++;
        lanes[lane] = parent;
      }
      edges.push({ row, col, parent, lane, color: laneColors[lane] });
    });
  });
  const segments: GraphSegment[] = [];
  for (const edge of edges) {
    const add = (x1, y1, x2, y2) => {
      if (y2 > y1) segments.push({ x1, y1, x2, y2, color: edge.color });
    };
    const parentRow = rowOf.get(edge.parent);
    if (parentRow === undefined) {
      add(edge.col, edge.row, edge.lane, edge.row + 1);
      add(edge.lane, edge.row + 1, edge.lane, nodes.length);
      continue;
    }
    const parentCol = cols[parentRow];
    if (parentRow === edge.row + 1) {
      add(edge.col, edge.row, parentCol, parentRow);
      continue;
    }
    add(edge.col, edge.row, edge.lane, edge.row + 1);
    add(edge.lane, edge.row + 1, edge.lane, parentRow - 1);
    add(edge.lane, parentRow - 1, parentCol, parentRow);
  }
  let width = 0;
  for (const col of cols) width = Math.max(width, col + 1);
  for (const segment of segments) width = Math.max(width, segment.x1 + 1, segment.x2 + 1);
  return { cols, colors, segments, lanes: width };
}
