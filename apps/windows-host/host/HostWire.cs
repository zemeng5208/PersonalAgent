using System.Globalization;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("WindowsHost.HostFixture")]

namespace PersonalAgent.WindowsHost.Service;

// This validator reads the same Schema used by @personal-agent/contracts/windows-host.
// It supports only the schema constructs present in the provisional 0.1.0 frame contract.
internal sealed class HostWire
{
    private const int MaxFrameBytes = 1024 * 1024;
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private readonly JsonDocument _schema;
    private readonly JsonElement _definitions;
    private readonly Dictionary<string, JsonElement> _frames = new(StringComparer.Ordinal);

    internal HostWire(string schemaPath)
    {
        _schema = JsonDocument.Parse(File.ReadAllText(schemaPath));
        var root = _schema.RootElement;
        if (!root.TryGetProperty("$id", out var id) ||
            id.GetString() != "https://personal-agent.local/schema/windows-host-0.1.0")
            throw new InvalidDataException("Unsupported Windows Host schema");
        _definitions = root.GetProperty("$defs");
        foreach (var entry in root.GetProperty("oneOf").EnumerateArray())
        {
            var definition = Resolve(entry);
            var kind = definition.GetProperty("properties").GetProperty("kind").GetProperty("const").GetString();
            if (kind is null || !_frames.TryAdd(kind, definition))
                throw new InvalidDataException("Invalid Windows Host schema kinds");
        }
    }

    internal JsonDocument Parse(byte[] bytes)
    {
        if (bytes.Length == 0 || bytes.Length + 1 > MaxFrameBytes ||
            (bytes.Length >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf))
            throw new InvalidDataException("Invalid Windows Host frame length or encoding");
        var json = StrictUtf8.GetString(bytes);
        var document = JsonDocument.Parse(json, new JsonDocumentOptions {MaxDepth = 16});
        try { Validate(document.RootElement); return document; }
        catch { document.Dispose(); throw; }
    }

    internal byte[] Encode(object frame)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(frame);
        using var document = Parse(bytes);
        var line = new byte[bytes.Length + 1];
        bytes.CopyTo(line, 0);
        line[^1] = (byte)'\n';
        return line;
    }

    internal async Task WriteAsync(PipeStream pipe, object frame, CancellationToken cancellationToken)
    {
        await pipe.WriteAsync(Encode(frame), cancellationToken).ConfigureAwait(false);
        await pipe.FlushAsync(cancellationToken).ConfigureAwait(false);
    }

    private JsonElement Resolve(JsonElement definition)
    {
        if (!definition.TryGetProperty("$ref", out var reference)) return definition;
        const string prefix = "#/$defs/";
        var value = reference.GetString();
        if (value is null || !value.StartsWith(prefix, StringComparison.Ordinal))
            throw new InvalidDataException("Unsupported Windows Host schema reference");
        return _definitions.GetProperty(value[prefix.Length..]);
    }

    private void Validate(JsonElement frame)
    {
        if (frame.ValueKind != JsonValueKind.Object || !frame.TryGetProperty("kind", out var kindElement) ||
            kindElement.ValueKind != JsonValueKind.String ||
            !_frames.TryGetValue(kindElement.GetString()!, out var definition))
            throw new InvalidDataException("Unknown Windows Host frame");

        var properties = definition.GetProperty("properties");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in frame.EnumerateObject())
        {
            if (!seen.Add(property.Name) || !properties.TryGetProperty(property.Name, out var constraint))
                throw new InvalidDataException("Duplicate or unknown Windows Host field");
            ValidateValue(property.Value, Resolve(constraint));
            if (property.Name is "deadline" or "expiresAt" or "startedAt" or "finishedAt")
                ValidateUtc(property.Value.GetString()!);
        }
        foreach (var required in definition.GetProperty("required").EnumerateArray())
            if (!seen.Contains(required.GetString()!))
                throw new InvalidDataException("Missing Windows Host field");

        if (kindElement.GetString() == "result")
        {
            var verified = frame.GetProperty("state").GetString() == "verified";
            if (verified && (!frame.TryGetProperty("evidenceRef", out _) ||
                             frame.TryGetProperty("errorCode", out _)) ||
                !verified && !frame.TryGetProperty("errorCode", out _) ||
                DateTime.Parse(frame.GetProperty("finishedAt").GetString()!, CultureInfo.InvariantCulture) <
                DateTime.Parse(frame.GetProperty("startedAt").GetString()!, CultureInfo.InvariantCulture))
                throw new InvalidDataException("Invalid Windows Host result evidence or time");
        }
    }

    private static void ValidateUtc(string value)
    {
        if (!DateTime.TryParseExact(value, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
                CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                out var parsed) || parsed.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture) != value)
            throw new InvalidDataException("Invalid Windows Host UTC time");
    }

    private static void ValidateValue(JsonElement value, JsonElement constraint)
    {
        if (value.ValueKind != JsonValueKind.String)
            throw new InvalidDataException("Windows Host field must be a string");
        var text = value.GetString()!;
        if (constraint.TryGetProperty("const", out var constant) && text != constant.GetString())
            throw new InvalidDataException("Windows Host field differs from contract");
        if (constraint.TryGetProperty("enum", out var options) &&
            !options.EnumerateArray().Any(option => text == option.GetString()))
            throw new InvalidDataException("Invalid Windows Host field value");
        if (constraint.TryGetProperty("minLength", out var minimum) && text.Length < minimum.GetInt32() ||
            constraint.TryGetProperty("maxLength", out var maximum) && text.Length > maximum.GetInt32())
            throw new InvalidDataException("Windows Host field length is invalid");
        if (constraint.TryGetProperty("pattern", out var pattern) &&
            !Regex.IsMatch(text, pattern.GetString()!, RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100)))
            throw new InvalidDataException("Windows Host field pattern is invalid");
    }
}

internal sealed class BoundedJsonlReader(Stream input)
{
    private readonly byte[] _buffer = new byte[8192];
    private int _position;
    private int _length;

    internal async Task<byte[]?> ReadAsync(CancellationToken cancellationToken)
    {
        using var frame = new MemoryStream();
        while (true)
        {
            if (_position == _length)
            {
                _length = await input.ReadAsync(_buffer, cancellationToken).ConfigureAwait(false);
                _position = 0;
                if (_length == 0)
                {
                    if (frame.Length != 0) throw new InvalidDataException("Incomplete Windows Host frame");
                    return null;
                }
            }
            var next = _buffer[_position++];
            if (frame.Length + 1 > 1024 * 1024)
                throw new InvalidDataException("Windows Host frame exceeds 1 MiB");
            if (next == (byte)'\n')
            {
                var bytes = frame.ToArray();
                if (bytes.Length == 0 || bytes[^1] == (byte)'\r')
                    throw new InvalidDataException("Invalid Windows Host JSONL delimiter");
                return bytes;
            }
            frame.WriteByte(next);
        }
    }
}
