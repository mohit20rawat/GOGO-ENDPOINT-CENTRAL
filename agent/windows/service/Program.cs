using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Net.Http.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace GogoEndpointCentral.Service;

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        if (args.Length > 0 && args[0].Equals("--enroll", StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                await Enrollment.RunAsync();
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"Enrollment failed: {ex.Message}");
                return 1;
            }
        }

        var builder = Host.CreateApplicationBuilder(args);
        builder.Services.AddWindowsService(options => options.ServiceName = "GOGO Endpoint Central Agent");
        builder.Services.AddHostedService<AgentWorker>();
        await builder.Build().RunAsync();
        return 0;
    }
}

internal sealed class AgentWorker(ILogger<AgentWorker> logger) : BackgroundService
{
    private static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan RotationInterval = TimeSpan.FromHours(24);
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private string? _token;
    private string? _baseUrl;
    private DateTimeOffset _rotateAfter;
    private readonly HttpClient _http = new() { Timeout = RequestTimeout };

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            var state = AgentState.Load();
            _baseUrl = state.ServerUrl;
            _token = AgentState.LoadToken();
            _rotateAfter = DateTimeOffset.UtcNow.Add(RotationInterval);
            logger.LogInformation("GOGO agent service started; heartbeat interval is {IntervalSeconds}s.", HeartbeatInterval.TotalSeconds);

            var retrySeconds = (int)HeartbeatInterval.TotalSeconds;
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    await SendHeartbeatAsync(stoppingToken);
                    if (DateTimeOffset.UtcNow >= _rotateAfter)
                        await RotateTokenAsync(stoppingToken);
                    retrySeconds = (int)HeartbeatInterval.TotalSeconds;
                    await Task.Delay(HeartbeatInterval, stoppingToken);
                }
                catch (HttpRequestException ex) when (ex.StatusCode == System.Net.HttpStatusCode.Unauthorized)
                {
                    logger.LogCritical("Agent credential was rejected. Stop the service and re-enroll this device.");
                    return;
                }
                catch (TokenPersistenceException)
                {
                    logger.LogCritical("Server-side token rotation committed but local persistence failed. Re-enrollment is required.");
                    return;
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception ex)
                {
                    logger.LogWarning("Agent request failed ({ErrorType}); retrying in {DelaySeconds}s.", ex.GetType().Name, retrySeconds);
                    await Task.Delay(TimeSpan.FromSeconds(retrySeconds), stoppingToken);
                    retrySeconds = Math.Min(900, Math.Max(15, retrySeconds * 2));
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        catch (Exception ex)
        {
            logger.LogCritical("Agent service could not initialize ({ErrorType}). Check enrollment and state-file permissions.", ex.GetType().Name);
            throw;
        }
        finally
        {
            _token = null;
            _http.Dispose();
            logger.LogInformation("GOGO agent service stopped.");
        }
    }

    private async Task SendHeartbeatAsync(CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{_baseUrl}/api/agent/heartbeat");
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", _token);
        request.Content = JsonContent.Create(new { agentVersion = "0.2.0" }, options: JsonOptions);
        using var response = await _http.SendAsync(request, ct);
        if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
            throw new HttpRequestException("Agent credential rejected.", null, response.StatusCode);
        response.EnsureSuccessStatusCode();
        logger.LogInformation("Agent heartbeat accepted.");
    }

    private async Task RotateTokenAsync(CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{_baseUrl}/api/agent/rotate-token");
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", _token);
        request.Content = JsonContent.Create(new { }, options: JsonOptions);
        using var response = await _http.SendAsync(request, ct);
        if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
            throw new HttpRequestException("Agent credential rejected during rotation.", null, response.StatusCode);
        response.EnsureSuccessStatusCode();
        var payload = await response.Content.ReadFromJsonAsync<RotationResponse>(JsonOptions, ct);
        if (string.IsNullOrWhiteSpace(payload?.AgentToken))
            throw new InvalidOperationException("Rotation response did not contain a replacement token.");

        // Server invalidates the old token at commit. If saving fails, stop immediately:
        // retrying with the old token would lock the device out.
        try
        {
            AgentState.SaveToken(payload.AgentToken);
        }
        catch
        {
            logger.LogCritical("Server rotated the credential but local persistence failed. Re-enrollment is required.");
            throw new TokenPersistenceException();
        }
        _token = payload.AgentToken;
        _rotateAfter = DateTimeOffset.UtcNow.Add(RotationInterval);
        logger.LogInformation("Agent credential rotated and securely saved.");
    }

    private sealed record RotationResponse([property: JsonPropertyName("agentToken")] string? AgentToken);
}

internal sealed record AgentConfig(string ServerUrl);

internal static class AgentState
{
    internal static readonly string DirectoryPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "GogoEndpointCentral");
    private static readonly string ConfigPath = Path.Combine(DirectoryPath, "config.json");
    private static readonly string TokenPath = Path.Combine(DirectoryPath, "agent-token.dpapi");
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("GOGO-EndpointCentral-Agent-v1");

    internal static AgentConfig Load()
    {
        var config = JsonSerializer.Deserialize<AgentConfig>(File.ReadAllText(ConfigPath), new JsonSerializerOptions(JsonSerializerDefaults.Web))
            ?? throw new InvalidOperationException("Agent config is empty.");
        if (!Uri.TryCreate(config.ServerUrl, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
            throw new InvalidOperationException("Configured server URL must be absolute HTTPS.");
        return config with { ServerUrl = uri.ToString().TrimEnd('/') };
    }

    internal static string LoadToken()
    {
        var encrypted = File.ReadAllBytes(TokenPath);
        var clear = ProtectedData.Unprotect(encrypted, Entropy, DataProtectionScope.LocalMachine);
        try { return Encoding.UTF8.GetString(clear); }
        finally { CryptographicOperations.ZeroMemory(clear); }
    }

    internal static void SaveToken(string token)
    {
        Directory.CreateDirectory(DirectoryPath);
        var clear = Encoding.UTF8.GetBytes(token);
        try
        {
            var encrypted = ProtectedData.Protect(clear, Entropy, DataProtectionScope.LocalMachine);
            var temp = TokenPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllBytes(temp, encrypted);
            File.Move(temp, TokenPath, true);
        }
        finally { CryptographicOperations.ZeroMemory(clear); }
    }

    internal static void SaveConfig(string serverUrl)
    {
        Directory.CreateDirectory(DirectoryPath);
        File.WriteAllText(ConfigPath, JsonSerializer.Serialize(new AgentConfig(serverUrl), new JsonSerializerOptions(JsonSerializerDefaults.Web)));
    }
}

internal static class Enrollment
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    internal static async Task RunAsync()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Enrollment is supported on Windows only.");
        using var identity = WindowsIdentity.GetCurrent();
        var principal = new WindowsPrincipal(identity);
        if (!principal.IsInRole(WindowsBuiltInRole.Administrator))
            throw new InvalidOperationException("Run enrollment from an elevated PowerShell window so state-file permissions can be configured.");

        Console.Write("GOGO server HTTPS URL: ");
        var url = Console.ReadLine()?.Trim() ?? "";
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
            throw new InvalidOperationException("Server URL must be absolute HTTPS.");
        url = uri.ToString().TrimEnd('/');

        Console.Write("Single-use enrollment token: ");
        var tokenChars = new StringBuilder();
        while (true)
        {
            var key = Console.ReadKey(intercept: true);
            if (key.Key == ConsoleKey.Enter) { Console.WriteLine(); break; }
            if (key.Key == ConsoleKey.Backspace) { if (tokenChars.Length > 0) tokenChars.Length--; continue; }
            if (!char.IsControl(key.KeyChar)) tokenChars.Append(key.KeyChar);
        }
        var enrollmentToken = tokenChars.ToString();
        if (enrollmentToken.Length < 20 || enrollmentToken.Length > 200)
            throw new InvalidOperationException("Enrollment token length is invalid.");

        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
        var body = new
        {
            enrollmentToken,
            name = Environment.MachineName,
            os = "Windows",
            osVersion = Environment.OSVersion.VersionString
        };
        using var response = await client.PostAsJsonAsync($"{url}/api/agent/enroll", body, JsonOptions);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"Server enrollment failed with HTTP {(int)response.StatusCode}.");
        var result = await response.Content.ReadFromJsonAsync<EnrollmentResponse>(JsonOptions);
        if (string.IsNullOrWhiteSpace(result?.AgentToken))
            throw new InvalidOperationException("Server response did not include an agent token.");

        try
        {
            AgentState.SaveConfig(url);
            AgentState.SaveToken(result.AgentToken);
            Console.WriteLine($"Enrolled device: {result.DeviceId}");
            Console.WriteLine("Token encrypted with machine-scope DPAPI. Run install-agent-service.ps1 to configure service permissions.");
        }
        finally
        {
            tokenChars.Clear();
            enrollmentToken = "";
        }
    }

    private sealed record EnrollmentResponse(
        [property: JsonPropertyName("deviceId")] string? DeviceId,
        [property: JsonPropertyName("agentToken")] string? AgentToken);
}

internal sealed class TokenPersistenceException : Exception { }
