import { exists } from '@/utils/helpers';
import supabase from '@/utils/supabase';
import { createWriteStream, promises as fsPromises, readFileSync } from 'fs';
import fetch from 'node-fetch';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export async function POST(req: Request) {
  // Ensure the API key is set
  const elevenLabsApiKey = process.env.ELEVEN_LABS_API_KEY;
  if (!elevenLabsApiKey) {
    return new Response(
      JSON.stringify({
        error: { statusCode: 500, message: 'Server configuration error' }
      }),
      { status: 500 }
    );
  }

  // Ensure the method is POST
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({
        error: { statusCode: 405, message: 'Method Not Allowed' }
      }),
      { status: 405 }
    );
  }

  const { text, voiceId } = await req.json();

  // Check if the values exist
  if (!exists(text) || !exists(voiceId)) {
    return new Response(
      JSON.stringify({
        error: {
          statusCode: 400,
          message: 'Missing text or voiceId in the request body.'
        }
      }),
      { status: 400 }
    );
  }

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          accept: 'audio.mpeg',
          'content-type': 'application/json',
          'xi-api-key': elevenLabsApiKey
        },
        body: JSON.stringify({
          text: text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.5,
            use_speaker_boost: true
          }
        })
      }
    );

    // Handle errors
    if (!response.ok || !response.body) {
      const errorText = await response.text();
      console.error(
        `Failed to convert text to speech: ${response.status} ${errorText}`
      );
      return new Response(
        JSON.stringify({
          error: {
            statusCode: response.status,
            message: errorText
          }
        }),
        { status: response.status }
      );
    }

    const data = response.body;

    const uuid = uuidv4();

    const tempDir =
      process.env.NEXT_PUBLIC_SITE_URL !== 'http://localhost:3000'
        ? os.tmpdir()
        : path.resolve('./temp');

    await fsPromises.mkdir(tempDir, { recursive: true });
    const tempFilePath = path.join(tempDir, `translated-audio-${uuid}.mp3`);
    const fileStream = createWriteStream(tempFilePath);

    for await (const chunk of data) {
      fileStream.write(chunk);
    }
    fileStream.end();

    const url = await new Promise<string>(async (resolve, reject) => {
      fileStream.on('finish', async function () {
        try {
          const audioData = readFileSync(tempFilePath);
          const filePath = `public/output-audio-${Date.now()}.mp3`;
          const { data, error } = await supabase.storage
            .from('translation')
            .upload(filePath, audioData, {
              contentType: 'audio/mp3',
              upsert: false
            });

          if (error) {
            console.error('Error uploading audio to Supabase:', error);
            reject(error);
          }

          if (!data) {
            console.error('No data returned from Supabase');
            reject('No data returned from Supabase');
          }

          const url = `${
            process.env.NEXT_PUBLIC_SUPABASE_URL
          }/storage/v1/object/public/translation/${data!.path}`;
          resolve(url);
        } catch (error) {
          console.error('Error uploading audio to Supabase:', error);
          reject(error);
        }
      });
    });

    // Clean up temp files and directory
    await fsPromises.unlink(tempFilePath);

    return new Response(JSON.stringify({ data: url }), {
      status: 200
    });
  } catch (error) {
    console.error(`Failed to convert text to speech: `, error);
    return new Response(JSON.stringify({ error: { statusCode: 500 } }), {
      status: 500,
      statusText: `Failed to convert text to speech: ${error}`
    });
  }
}
