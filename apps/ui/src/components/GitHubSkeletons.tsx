import type { CSSProperties } from "react";
import { Bone, CodeLinesSkeleton, SkeletonRegion } from "./Loading.js";

const TITLE_WIDTHS = ["64%", "48%", "72%", "41%", "58%", "36%"];
const META_WIDTHS = ["52%", "60%", "44%", "56%", "38%", "48%"];
const FILE_WIDTHS = [118, 92, 140, 76, 124, 104, 86];

function indexStyle(i: number): CSSProperties {
  return { "--i": i } as CSSProperties;
}

export function GitHubListSkeleton({ label, rows = 6 }: { label: string; rows?: number }) {
  return (
    <SkeletonRegion label={label} className="pr-inbox-groups">
      <section className="pr-inbox-group">
        <div className="pr-inbox-group-head">
          <Bone w={12} h={12} round />
          <Bone w={96} h={9} />
          <Bone w={14} h={9} />
        </div>
        <div className="pr-inbox-rows">
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="hub-row" style={indexStyle(i)}>
              <span className="hub-state">
                <Bone w={14} h={14} round />
              </span>
              <div className="pr-inbox-title-col">
                <div className="skel-line">
                  <Bone w={TITLE_WIDTHS[i % TITLE_WIDTHS.length]} h={11} />
                </div>
                <div className="skel-line">
                  <Bone w={META_WIDTHS[i % META_WIDTHS.length]} h={8} />
                </div>
              </div>
              <span className="hub-people">
                <Bone w={20} h={20} />
                {i % 3 !== 2 && <Bone w={16} h={16} />}
              </span>
              <div className="hub-gate">
                <div className="skel-line">
                  <Bone w={i % 2 === 0 ? 96 : 72} h={9} />
                </div>
                <div className="skel-line">
                  <Bone w={i % 2 === 0 ? 64 : 84} h={7} />
                </div>
              </div>
              <span className="hub-action">
                <Bone w={i % 2 === 0 ? "100%" : "78%"} h={28} />
              </span>
            </div>
          ))}
        </div>
      </section>
    </SkeletonRegion>
  );
}

export function PrDetailSkeleton() {
  return (
    <SkeletonRegion label="Loading pull request" className="pr-detail-wrap">
      <div className="skel-line skel-detail-title">
        <Bone w="54%" h={18} />
        <Bone w={40} h={18} />
      </div>
      <div className="pr-detail-sub">
        <Bone w={58} h={22} round />
        <Bone w={20} h={20} round />
        <Bone w={300} h={10} />
      </div>
      <div className="pr-detail-tabs">
        {[96, 62, 54, 66].map((w, i) => (
          <span key={w} className={`skel-detail-tab${i === 0 ? " active" : ""}`}>
            <Bone w={w} h={10} />
          </span>
        ))}
      </div>
      <div className="pr-detail-cols">
        <div className="pr-detail-main">
          {[["92%", "84%", "61%"], ["76%", "40%"]].map((lines, i) => (
            <div key={i} className="pr-detail-comment">
              <div className="skel-line skel-comment-head">
                <Bone w={20} h={20} round />
                <Bone w={84} h={9} />
                <Bone w={56} h={8} />
              </div>
              <div className="skel-comment-body">
                {lines.map((w) => (
                  <Bone key={w} w={w} h={9} />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="pr-detail-side">
          {[2, 3, 2].map((count, i, all) => (
            <div key={i} className={`pr-detail-side-block skel-side-block${i === all.length - 1 ? " last" : ""}`}>
              <Bone w={72} h={8} />
              {Array.from({ length: count }, (_, j) => (
                <div key={j} className="skel-line">
                  <Bone w={16} h={16} round />
                  <Bone w={j % 2 === 0 ? "62%" : "48%"} h={9} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </SkeletonRegion>
  );
}

export function PrFilesSkeleton() {
  return (
    <SkeletonRegion label="Loading changed files" className="pr-files-layout">
      <div className="pr-files-tree">
        <div className="pr-files-summary">
          <Bone w={44} h={8} />
          <Bone w={28} h={8} />
          <Bone w={28} h={8} />
        </div>
        {FILE_WIDTHS.map((w, i) => (
          <div key={i} className="skel-line skel-files-row">
            <Bone w={14} h={14} />
            <Bone w={w} h={9} />
            <span className="skel-fill" />
            <Bone w={36} h={8} />
          </div>
        ))}
      </div>
      <div className="pr-files-diff">
        <div className="pr-files-diff-head">
          <Bone w={14} h={14} />
          <Bone w="38%" h={9} />
        </div>
        <div className="skel-files-code">
          <CodeLinesSkeleton lines={14} />
        </div>
      </div>
    </SkeletonRegion>
  );
}

export function CheckLogSkeleton() {
  return (
    <SkeletonRegion label="Loading log">
      <CodeLinesSkeleton lines={12} />
    </SkeletonRegion>
  );
}

export function PrPanelSkeleton() {
  return (
    <SkeletonRegion label="Loading pull request">
      {[3, 2, 2].map((count, i) => (
        <section key={i} className="pr-panel-sec">
          <div className="pr-panel-sec-head">
            <Bone w={13} h={13} round />
            <Bone w={i === 0 ? 132 : 88} h={8} />
          </div>
          {Array.from({ length: count }, (_, j) => (
            <div key={j} className="skel-line skel-panel-row">
              <Bone w={13} h={13} round />
              <Bone w={j % 2 === 0 ? "58%" : "44%"} h={8} />
              <span className="skel-fill" />
              <Bone w={30} h={7} />
            </div>
          ))}
        </section>
      ))}
    </SkeletonRegion>
  );
}

export function SubjectCardSkeleton({ label }: { label: string }) {
  return (
    <SkeletonRegion label={label} className="wf-run-pr">
      <Bone w={16} h={16} round />
      <div className="skel-side-block skel-fill">
        <Bone w="62%" h={10} />
        <Bone w="38%" h={8} />
      </div>
      <Bone w={72} h={18} round />
    </SkeletonRegion>
  );
}

export function PromptPreviewSkeleton({ label }: { label: string }) {
  return (
    <SkeletonRegion label={label} className="sp-code sp-preview">
      <CodeLinesSkeleton lines={8} />
    </SkeletonRegion>
  );
}
