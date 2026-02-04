import type { Context } from "@oomol/types/oocana";
import fs from "fs";
import path from "path";

//#region generated meta
type Inputs = {
  image_url: string;
  prompt: string;
  resolution: "auto" | "720p" | "1080p" | null;
  aspect_ratio: "auto" | "9:16" | "16:9" | null;
  duration: 4 | 8 | 12 | null;
};
type Outputs = {
  video_url: string;
  video_path: string;
  video_id: string;
  width: number;
  height: number;
  fps: number;
  actual_duration: number;
  num_frames: number;
  thumbnail_url: string;
};
//#endregion

const BASE_URL = "https://fusion-api.oomol.com/v1/fal-sora2-image-to-video";
const POLL_INTERVAL = 2000; // 2 seconds

interface SubmitResponse {
  success: boolean;
  sessionID: string;
}

interface StateResponse {
  success: boolean;
  state: "pending" | "processing" | "completed" | "failed";
  progress: number;
}

interface ResultResponse {
  success: boolean;
  state: "completed";
  data: {
    video: {
      url: string;
      content_type: string;
      file_name: string;
      file_size: number | null;
      width: number;
      height: number;
      fps: number;
      duration: number;
      num_frames: number;
    };
    video_id: string;
    thumbnail: {
      url: string;
      content_type: string;
      file_name: string;
      file_size: number | null;
      width: number | null;
      height: number | null;
    };
    spritesheet: {
      url: string;
      content_type: string;
      file_name: string;
      file_size: number | null;
      width: number | null;
      height: number | null;
    };
  };
}

async function downloadFile(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(buffer));
}

export default async function (
  params: Inputs,
  context: Context<Inputs, Outputs>
): Promise<Outputs> {
  const token = await context.getOomolToken();

  // Validate inputs
  const imageURL = params.image_url?.trim();
  if (!imageURL || imageURL.length === 0) {
    throw new Error("Image URL is required");
  }

  const prompt = params.prompt?.trim();
  if (!prompt || prompt.length === 0 || prompt.length > 5000) {
    throw new Error("Prompt must be between 1 and 5000 characters");
  }

  // Use defaults for optional parameters
  const resolution = params.resolution || "auto";
  const aspectRatio = params.aspect_ratio || "auto";
  const duration = params.duration || 4;

  // Step 1: Submit the task
  context.reportProgress(5);
  const submitResponse = await fetch(`${BASE_URL}/submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      prompt,
      imageURL,
      resolution,
      aspectRatio,
      duration,
    }),
  });

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    throw new Error(`Failed to submit task: ${submitResponse.statusText} - ${errorText}`);
  }

  const submitData: SubmitResponse = await submitResponse.json();
  if (!submitData.success || !submitData.sessionID) {
    throw new Error("Failed to get session ID from submit response");
  }

  const sessionID = submitData.sessionID;
  context.reportProgress(10);

  // Step 2: Poll for task completion
  let state: StateResponse;
  let attempts = 0;
  const maxAttempts = 600; // 20 minutes maximum (600 * 2 seconds)

  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));

    const stateResponse = await fetch(`${BASE_URL}/state/${sessionID}`, {
      headers: {
        "Authorization": `Bearer ${token}`,
      },
    });

    if (!stateResponse.ok) {
      throw new Error(`Failed to get task state: ${stateResponse.statusText}`);
    }

    state = await stateResponse.json();

    if (!state.success) {
      throw new Error("State check returned unsuccessful response");
    }

    // Report progress (map 0-100 API progress to 10-90 UI progress)
    const progressPercent = Math.min(90, 10 + (state.progress * 0.8));
    context.reportProgress(Math.round(progressPercent));

    if (state.state === "completed") {
      break;
    }

    if (state.state === "failed") {
      throw new Error("Video generation failed");
    }

    attempts++;
  }

  if (attempts >= maxAttempts) {
    throw new Error("Task timed out after 20 minutes");
  }

  context.reportProgress(90);

  // Step 3: Get the result
  const resultResponse = await fetch(`${BASE_URL}/result/${sessionID}`, {
    headers: {
      "Authorization": `Bearer ${token}`,
    },
  });

  if (!resultResponse.ok) {
    throw new Error(`Failed to get task result: ${resultResponse.statusText}`);
  }

  const resultData: ResultResponse = await resultResponse.json();
  if (!resultData.success || resultData.state !== "completed") {
    throw new Error("Failed to get completed result");
  }

  context.reportProgress(95);

  // Step 4: Download the video
  const videoUrl = resultData.data.video.url;
  const videoFileName = resultData.data.video.file_name || `sora2_image_to_video_${sessionID}.mp4`;
  const videoPath = path.join(context.sessionDir, videoFileName);

  await downloadFile(videoUrl, videoPath);

  context.reportProgress(100);

  // Display video preview
  context.preview({
    type: "video",
    data: videoPath,
  });

  return {
    video_url: videoUrl,
    video_path: videoPath,
    video_id: resultData.data.video_id,
    width: resultData.data.video.width,
    height: resultData.data.video.height,
    fps: resultData.data.video.fps,
    actual_duration: resultData.data.video.duration,
    num_frames: resultData.data.video.num_frames,
    thumbnail_url: resultData.data.thumbnail.url,
  };
}
