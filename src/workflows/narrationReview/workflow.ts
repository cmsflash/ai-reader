import {
  finalizeContinualLearningAudioReviewStep,
  generateContinualLearningSentenceAudioStep,
  prepareContinualLearningAudioReviewStep,
} from "@/workflows/narrationReview/steps";

export async function createContinualLearningAudioReview(input: {
  ownerEmail: string;
}) {
  "use workflow";

  const preparation = await prepareContinualLearningAudioReviewStep(
    input.ownerEmail,
  );
  const generated = [];

  for (const sentence of preparation.sentences) {
    generated.push(
      await generateContinualLearningSentenceAudioStep(
        preparation,
        sentence,
      ),
    );
  }

  return finalizeContinualLearningAudioReviewStep(preparation, generated);
}
