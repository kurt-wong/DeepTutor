import { Suspense } from "react";
import { PracticePage } from "@/components/learning/practice/PracticePage";
import { LearningSkeleton } from "@/components/learning/LearningShell";
import { QCoreStudentPage } from "@/components/qcore/QCoreStudentPage";

export default function SpaceQuestionsPage() {
  return (
    <Suspense fallback={<LearningSkeleton />}>
      {/* QC 题目只读区：Question Core Student API 消费，零复制、不进 notebook 写路径 */}
      <QCoreStudentPage />
      <PracticePage mode="library" />
    </Suspense>
  );
}
