import { useDroppable } from "@dnd-kit/core";

type EmptyDropCellProps = {
  cellIndex: number;
  totalCardWidth: number;
  totalCardHeight: number;
};

export default function EmptyDropCell({
  cellIndex,
  totalCardWidth,
  totalCardHeight,
}: EmptyDropCellProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `empty-cell-${cellIndex}`,
    data: { cellIndex },
  });

  return (
    <div
      ref={setNodeRef}
      className={`flex items-center justify-center border-2 border-dashed rounded select-none transition-colors ${
        isOver
          ? "border-blue-400 bg-blue-50 dark:bg-blue-900/30"
          : "border-gray-300 dark:border-gray-500 bg-gray-50 dark:bg-gray-600/30"
      }`}
      style={{
        width: `${totalCardWidth}mm`,
        height: `${totalCardHeight}mm`,
        boxSizing: "border-box",
      }}
    >
      <span className="text-xs text-gray-400 dark:text-gray-500">
        {cellIndex + 1}
      </span>
    </div>
  );
}
