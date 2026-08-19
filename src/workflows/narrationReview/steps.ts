import {
  finalizeContinualLearningAudioReview,
  generateContinualLearningSentenceAudio,
  prepareContinualLearningAudioReview,
  type ContinualLearningAudioReviewGeneratedSentence,
  type ContinualLearningAudioReviewPreparation,
  type ContinualLearningAudioReviewResult,
  type ContinualLearningAudioReviewSentence,
} from "@/server/articles/continualLearningAudioReview";

export async function prepareContinualLearningAudioReviewStep(
  ownerEmail: string,
): Promise<ContinualLearningAudioReviewPreparation> {
  "use step";

  return prepareContinualLearningAudioReview(ownerEmail);
}

export async function generateContinualLearningSentenceAudioStep(
  preparation: ContinualLearningAudioReviewPreparation,
  sentence: ContinualLearningAudioReviewSentence,
): Promise<ContinualLearningAudioReviewGeneratedSentence> {
  "use step";

  return generateContinualLearningSentenceAudio(preparation, sentence);
}

// A transport retry after an ambiguous provider response can buy the same
// sentence twice. A manual workflow rerun safely reuses every stored key.
generateContinualLearningSentenceAudioStep.maxRetries = 0;

export async function finalizeContinualLearningAudioReviewStep(
  preparation: ContinualLearningAudioReviewPreparation,
  generated: ContinualLearningAudioReviewGeneratedSentence[],
): Promise<ContinualLearningAudioReviewResult> {
  "use step";

  return finalizeContinualLearningAudioReview(preparation, generated);
}
