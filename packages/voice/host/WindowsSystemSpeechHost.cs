using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Speech.AudioFormat;
using System.Speech.Recognition;
using System.Speech.Synthesis;

namespace PersonalAgent.VoiceHost {
    /// <summary>
    /// Fixed Windows System.Speech native host for bounded stdio recognition and synthesis.
    /// Does not require or execute PowerShell scripts, avoiding execution policy restrictions.
    /// </summary>
    internal static class Program {
        private const string CultureName = "zh-CN";
        private const int MaxAudioBytes = 1920000;
        private const int MaxTextBytes = 32768;
        private const int MaxTextCharacters = 8000;

        private static string EscapeJson(string s) {
            if (s == null) return "null";
            StringBuilder sb = new StringBuilder();
            sb.Append('"');
            foreach (char c in s) {
                switch (c) {
                    case '\\': sb.Append(@"\\"); break;
                    case '"': sb.Append(@"\"""); break;
                    case '\b': sb.Append(@"\b"); break;
                    case '\f': sb.Append(@"\f"); break;
                    case '\n': sb.Append(@"\n"); break;
                    case '\r': sb.Append(@"\r"); break;
                    case '\t': sb.Append(@"\t"); break;
                    default:
                        if (char.IsControl(c)) {
                            sb.AppendFormat(@"\u{0:x4}", (int)c);
                        } else {
                            sb.Append(c);
                        }
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        public static int Main(string[] args) {
            try {
                Console.OutputEncoding = new UTF8Encoding(false);
            } catch {
                // Best-effort console encoding initialization.
            }

            // Strictly require either two arguments (--mode <recognize|speak>)
            // or four arguments (--mode keyword --keyword <keyword>).
            // Any duplicate flags, missing arguments, or extraneous parameters are rejected immediately.
            if (args == null || (args.Length != 2 && args.Length != 4)) {
                Console.Out.WriteLine("{\"ok\":false,\"code\":\"EXTERNAL_FAILURE\"}");
                Console.Out.Flush();
                return 1;
            }

            string flag = args[0];
            string mode = args[1];

            if (!string.Equals(flag, "--mode", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(flag, "-Mode", StringComparison.OrdinalIgnoreCase)) {
                Console.Out.WriteLine("{\"ok\":false,\"code\":\"EXTERNAL_FAILURE\"}");
                Console.Out.Flush();
                return 1;
            }

            if (args.Length == 4) {
                if (!string.Equals(mode, "keyword", StringComparison.Ordinal)) {
                    Console.Out.WriteLine("{\"ok\":false,\"code\":\"EXTERNAL_FAILURE\"}");
                    Console.Out.Flush();
                    return 1;
                }
                string kwFlag = args[2];
                if (!string.Equals(kwFlag, "--keyword", StringComparison.OrdinalIgnoreCase) &&
                    !string.Equals(kwFlag, "-Keyword", StringComparison.OrdinalIgnoreCase)) {
                    Console.Out.WriteLine("{\"ok\":false,\"code\":\"EXTERNAL_FAILURE\"}");
                    Console.Out.Flush();
                    return 1;
                }
                string keyword = args[3];
                return RunKeywordMode(keyword);
            }

            if (!string.Equals(mode, "recognize", StringComparison.Ordinal) &&
                !string.Equals(mode, "speak", StringComparison.Ordinal)) {
                Console.Out.WriteLine("{\"ok\":false,\"code\":\"EXTERNAL_FAILURE\"}");
                Console.Out.Flush();
                return 1;
            }

            int exitCode = 1;
            string responseJson = "{\"ok\":false,\"code\":\"EXTERNAL_FAILURE\"}";
            byte[] block = new byte[8192];
            MemoryStream memory = new MemoryStream();
            byte[] textBytes = null;
            SpeechRecognitionEngine engine = null;
            SpeechSynthesizer synth = null;

            try {
                int limit = string.Equals(mode, "recognize", StringComparison.Ordinal)
                    ? MaxAudioBytes
                    : MaxTextBytes;

                using (Stream stdin = Console.OpenStandardInput()) {
                    int read;
                    while ((read = stdin.Read(block, 0, block.Length)) > 0) {
                        if (memory.Length + read > limit) {
                            throw new InvalidOperationException("bounded-input-rejected");
                        }
                        memory.Write(block, 0, read);
                    }
                }

                if (memory.Length <= 0) {
                    throw new InvalidOperationException("empty-input-rejected");
                }
                memory.Position = 0;

                if (string.Equals(mode, "recognize", StringComparison.Ordinal)) {
                    if (memory.Length % 2 != 0) {
                        throw new InvalidOperationException("invalid-pcm-frame");
                    }

                    RecognizerInfo targetRecognizer = null;
                    foreach (RecognizerInfo info in SpeechRecognitionEngine.InstalledRecognizers()) {
                        if (string.Equals(info.Culture.Name, CultureName, StringComparison.OrdinalIgnoreCase)) {
                            targetRecognizer = info;
                            break;
                        }
                    }

                    if (targetRecognizer == null) {
                        throw new NotSupportedException("zh-CN recognizer not found");
                    }

                    engine = new SpeechRecognitionEngine(targetRecognizer);
                    engine.LoadGrammar(new DictationGrammar());
                    SpeechAudioFormatInfo format = new SpeechAudioFormatInfo(
                        16000,
                        AudioBitsPerSample.Sixteen,
                        AudioChannel.Mono);
                    engine.SetInputToAudioStream(memory, format);
                    RecognitionResult result = engine.Recognize();
                    if (result == null || string.IsNullOrWhiteSpace(result.Text) || result.Text.Length > MaxTextCharacters) {
                        throw new InvalidOperationException("recognition-result-rejected");
                    }

                    responseJson = "{\"ok\":true,\"text\":" + EscapeJson(result.Text) + ",\"locale\":\"" + CultureName + "\"}";
                } else {
                    textBytes = memory.ToArray();
                    try {
                        string text = Encoding.UTF8.GetString(textBytes);
                        if (string.IsNullOrWhiteSpace(text) || text.Length > MaxTextCharacters) {
                            throw new InvalidOperationException("speech-text-rejected");
                        }

                        synth = new SpeechSynthesizer();
                        InstalledVoice targetVoice = null;
                        foreach (InstalledVoice voice in synth.GetInstalledVoices()) {
                            if (voice.Enabled && string.Equals(voice.VoiceInfo.Culture.Name, CultureName, StringComparison.OrdinalIgnoreCase)) {
                                targetVoice = voice;
                                break;
                            }
                        }

                        if (targetVoice == null) {
                            throw new NotSupportedException("zh-CN voice not found");
                        }

                        synth.SelectVoice(targetVoice.VoiceInfo.Name);
                        synth.SetOutputToDefaultAudioDevice();
                        synth.Speak(text);
                        synth.SetOutputToNull();
                        responseJson = "{\"ok\":true,\"locale\":\"" + CultureName + "\"}";
                    } finally {
                        if (textBytes != null) {
                            Array.Clear(textBytes, 0, textBytes.Length);
                        }
                    }
                }

                exitCode = 0;
            } catch (NotSupportedException) {
                responseJson = "{\"ok\":false,\"code\":\"UNSUPPORTED_CAPABILITY\"}";
                exitCode = 2;
            } catch (Exception) {
                responseJson = "{\"ok\":false,\"code\":\"EXTERNAL_FAILURE\"}";
                exitCode = 1;
            } finally {
                try {
                    if (synth != null) {
                        synth.SetOutputToNull();
                    }
                } catch { }
                try {
                    if (engine != null) {
                        engine.Dispose();
                    }
                } catch { }
                try {
                    if (synth != null) {
                        synth.Dispose();
                    }
                } catch { }
                try {
                    byte[] backing = memory.GetBuffer();
                    Array.Clear(backing, 0, backing.Length);
                } catch { }
                Array.Clear(block, 0, block.Length);
                memory.Dispose();

                try {
                    Console.Out.WriteLine(responseJson);
                    Console.Out.Flush();
                } catch { }
            }

            return exitCode;
        }

        private static int RunKeywordMode(string keyword) {
            if (string.IsNullOrWhiteSpace(keyword) || keyword.Length > 32) {
                Console.Out.WriteLine("{\"ok\":false,\"code\":\"EXTERNAL_FAILURE\"}");
                Console.Out.Flush();
                return 1;
            }
            foreach (char c in keyword) {
                if (char.IsControl(c) || c == '<' || c == '>' || c == '&' || c == '"' || c == '\'' || c == '\\' || c == ';' || c == '|' || c == '`') {
                    Console.Out.WriteLine("{\"ok\":false,\"code\":\"EXTERNAL_FAILURE\"}");
                    Console.Out.Flush();
                    return 1;
                }
            }

            RecognizerInfo targetRecognizer = null;
            foreach (RecognizerInfo info in SpeechRecognitionEngine.InstalledRecognizers()) {
                if (string.Equals(info.Culture.Name, CultureName, StringComparison.OrdinalIgnoreCase)) {
                    targetRecognizer = info;
                    break;
                }
            }

            if (targetRecognizer == null) {
                Console.Out.WriteLine("{\"ok\":false,\"code\":\"UNSUPPORTED_CAPABILITY\"}");
                Console.Out.Flush();
                return 2;
            }

            SpeechRecognitionEngine engine = null;
            PipedAudioStream audioStream = null;
            byte[] header = new byte[4];
            byte[] chunk = new byte[3200];

            try {
                GrammarBuilder gb = new GrammarBuilder(keyword);
                gb.Culture = targetRecognizer.Culture;
                Grammar grammar = new Grammar(gb);
                grammar.Name = "Keyword";

                engine = new SpeechRecognitionEngine(targetRecognizer);
                engine.LoadGrammar(grammar);

                engine.SpeechRecognized += delegate(object sender, SpeechRecognizedEventArgs e) {
                    try {
                        if (e.Result != null) {
                            Console.Out.WriteLine("{\"event\":\"detected\"}");
                            Console.Out.Flush();
                        }
                    } catch { }
                };

                audioStream = new PipedAudioStream();
                SpeechAudioFormatInfo format = new SpeechAudioFormatInfo(
                    16000,
                    AudioBitsPerSample.Sixteen,
                    AudioChannel.Mono);
                engine.SetInputToAudioStream(audioStream, format);
                engine.RecognizeAsync(RecognizeMode.Multiple);

                Console.Out.WriteLine("{\"event\":\"ready\"}");
                Console.Out.Flush();

                using (Stream stdin = Console.OpenStandardInput()) {
                    while (true) {
                        int headerRead = 0;
                        while (headerRead < 4) {
                            int r = stdin.Read(header, headerRead, 4 - headerRead);
                            if (r <= 0) {
                                goto KeywordEnded;
                            }
                            headerRead += r;
                        }

                        byte msgType = header[0];
                        byte ctrlCode = header[1];
                        int payloadLen = header[2] | (header[3] << 8);

                        if (msgType == 2) {
                            if (ctrlCode == 1) { // STOP
                                goto KeywordEnded;
                            }
                            goto KeywordEnded;
                        }

                        if (msgType != 1) {
                            throw new InvalidOperationException("invalid-message-type");
                        }

                        if (payloadLen <= 0 || payloadLen > 3200 || (payloadLen % 2) != 0) {
                            throw new InvalidOperationException("invalid-payload-length");
                        }

                        int payloadRead = 0;
                        while (payloadRead < payloadLen) {
                            int r = stdin.Read(chunk, payloadRead, payloadLen - payloadRead);
                            if (r <= 0) {
                                goto KeywordEnded;
                            }
                            payloadRead += r;
                        }

                        audioStream.WriteChunk(chunk, 0, payloadLen);
                    }
                }

            KeywordEnded:
                if (audioStream != null) {
                    audioStream.Complete();
                }
                return 0;
            } catch (NotSupportedException) {
                Console.Out.WriteLine("{\"ok\":false,\"code\":\"UNSUPPORTED_CAPABILITY\"}");
                Console.Out.Flush();
                return 2;
            } catch (Exception) {
                Console.Out.WriteLine("{\"ok\":false,\"code\":\"EXTERNAL_FAILURE\"}");
                Console.Out.Flush();
                return 1;
            } finally {
                try {
                    if (engine != null) {
                        engine.RecognizeAsyncCancel();
                        engine.Dispose();
                    }
                } catch { }
                try {
                    if (audioStream != null) {
                        audioStream.Dispose();
                    }
                } catch { }
                Array.Clear(header, 0, header.Length);
                Array.Clear(chunk, 0, chunk.Length);
            }
        }
    }

    internal sealed class PipedAudioStream : Stream {
        private readonly Queue<byte[]> _queue = new Queue<byte[]>();
        private readonly object _lock = new object();
        private byte[] _currentChunk;
        private int _chunkOffset;
        private bool _ended;
        private bool _disposed;

        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return false; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { throw new NotSupportedException(); } }
        public override long Position {
            get { throw new NotSupportedException(); }
            set { throw new NotSupportedException(); }
        }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
        public override void SetLength(long value) { throw new NotSupportedException(); }

        public void WriteChunk(byte[] data, int offset, int count) {
            lock (_lock) {
                if (_ended || _disposed) return;
                byte[] copy = new byte[count];
                Buffer.BlockCopy(data, offset, copy, 0, count);
                _queue.Enqueue(copy);
                Monitor.PulseAll(_lock);
            }
        }

        public void Complete() {
            lock (_lock) {
                _ended = true;
                Monitor.PulseAll(_lock);
            }
        }

        public override int Read(byte[] buffer, int offset, int count) {
            lock (_lock) {
                while (!_disposed) {
                    if (_currentChunk != null) {
                        int remaining = _currentChunk.Length - _chunkOffset;
                        int toCopy = Math.Min(remaining, count);
                        Buffer.BlockCopy(_currentChunk, _chunkOffset, buffer, offset, toCopy);
                        _chunkOffset += toCopy;
                        if (_chunkOffset >= _currentChunk.Length) {
                            Array.Clear(_currentChunk, 0, _currentChunk.Length);
                            _currentChunk = null;
                            _chunkOffset = 0;
                        }
                        return toCopy;
                    }
                    if (_queue.Count > 0) {
                        _currentChunk = _queue.Dequeue();
                        _chunkOffset = 0;
                        continue;
                    }
                    if (_ended) {
                        return 0;
                    }
                    Monitor.Wait(_lock);
                }
                return 0;
            }
        }

        protected override void Dispose(bool disposing) {
            lock (_lock) {
                _disposed = true;
                _ended = true;
                if (_currentChunk != null) {
                    Array.Clear(_currentChunk, 0, _currentChunk.Length);
                    _currentChunk = null;
                }
                while (_queue.Count > 0) {
                    byte[] chunk = _queue.Dequeue();
                    Array.Clear(chunk, 0, chunk.Length);
                }
                Monitor.PulseAll(_lock);
            }
            base.Dispose(disposing);
        }
    }
}
