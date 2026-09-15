from dotenv import load_dotenv
from google import genai
from google.genai import types

# .env 파일 로드 (이 줄이 있어야 Vertex AI 환경변수가 적용됩니다)
load_dotenv()

client = genai.Client()

video_uri = "https://www.youtube.com/watch?v=pdh4lkZKT6A"
video_part = types.Part.from_uri(file_uri=video_uri, mime_type="video/mp4")

response = client.models.generate_content(
    model="gemini-3.8-flash",
    contents=[
        video_part,
        "핵심 논지 3가지가 뭐야?",
    ],
)
print(response.text)
