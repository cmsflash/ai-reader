import { NextResponse } from "next/server";
import {
  requireAppUser,
  requireIntegrationOwnerResponse,
} from "@/server/auth/access";
import { importTokenConfigured } from "@/server/auth/importToken";
import {
  createDropboxReadClient,
  DROPBOX_ATVOICE_FOLDER,
  getDropboxConfiguredStatus,
} from "@/server/integrations/dropboxClient";
import {
  createInstapaperClient,
  getInstapaperConfigurationStatus,
} from "@/server/integrations/instapaperClient";

export const runtime = "nodejs";

const defaultInstapaperFolders = [
  { id: "unread", title: "Unread" },
  { id: "starred", title: "Liked" },
  { id: "archive", title: "Archive" },
];

export async function GET() {
  const auth = await requireAppUser();

  if (auth.response) {
    return auth.response;
  }

  const ownerError = requireIntegrationOwnerResponse(auth.user.ownerEmail);

  if (ownerError) {
    return ownerError;
  }

  const instapaperConfiguration = getInstapaperConfigurationStatus();
  const dropboxConfiguration = getDropboxConfiguredStatus();
  let instapaperUsername: string | undefined;
  let instapaperFolders = defaultInstapaperFolders;
  let instapaperMessage: string | undefined;
  let dropboxMessage: string | undefined;

  if (instapaperConfiguration.configured) {
    try {
      const client = createInstapaperClient();
      const [user, customFolders] = await Promise.all([
        client.verifyCredentials(),
        client.listFolders(),
      ]);
      instapaperUsername = user.username;
      instapaperFolders = [
        ...defaultInstapaperFolders,
        ...customFolders.map((folder) => ({
          id: String(folder.folder_id),
          title: folder.display_title || folder.title,
          count: folder.count,
        })),
      ];
    } catch (error) {
      instapaperMessage = messageFromError(error);
    }
  }

  if (dropboxConfiguration.configured) {
    try {
      await createDropboxReadClient().listAtVoiceFiles();
    } catch (error) {
      dropboxMessage = messageFromError(error);
    }
  }

  return NextResponse.json({
    instapaper: {
      configured: instapaperConfiguration.configured,
      connected:
        instapaperConfiguration.configured && !instapaperMessage,
      username: instapaperUsername,
      folders: instapaperFolders,
      message: instapaperMessage,
    },
    dropbox: {
      configured: dropboxConfiguration.configured,
      connected: dropboxConfiguration.configured && !dropboxMessage,
      folder: DROPBOX_ATVOICE_FOLDER,
      message: dropboxMessage,
    },
    personalImports: {
      configured: importTokenConfigured(),
    },
  });
}

function messageFromError(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Could not verify Instapaper credentials.";
}
