import { randomUUID } from "node:crypto";
import prisma from "./prisma";

export async function ensureCommercialAgreementAttachmentTokens(): Promise<void> {
  const attachments = await prisma.commercialAgreementAttachment.findMany({
    where: { biAccessToken: null },
    select: { id: true }
  });

  for (const attachment of attachments) {
    await prisma.commercialAgreementAttachment.update({
      where: { id: attachment.id },
      data: { biAccessToken: randomUUID() }
    });
  }
}
