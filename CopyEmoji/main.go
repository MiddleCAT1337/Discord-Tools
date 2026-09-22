package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"unicode"
)

const (
	discordAPI   = "https://discord.com/api/v10"
	userAgent    = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
	workerCount  = 16
	maxErrBody   = 512
)

type emojiEntry struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Animated bool   `json:"animated"`
}

type downloadJob struct {
	entry emojiEntry
	path  string
	url   string
}

func main() {
	reader := bufio.NewReader(os.Stdin)

	token := readLine(reader, "User Token: ")
	if token == "" {
		fatal("token is required")
	}

	guildID := readLine(reader, "Server ID: ")
	guildID = strings.TrimSpace(guildID)
	if guildID == "" || !isSnowflake(guildID) {
		fatal("server ID must be a numeric snowflake")
	}

	client := &http.Client{}

	emojis, err := fetchGuildEmojis(client, token, guildID)
	if err != nil {
		fatal("%v", err)
	}
	if len(emojis) == 0 {
		fmt.Println("No emojis on this server.")
		return
	}

	if err := os.MkdirAll(guildID, 0o755); err != nil {
		fatal("create folder: %v", err)
	}

	usedNames := make(map[string]struct{})
	jobs := make([]downloadJob, 0, len(emojis))
	for _, e := range emojis {
		ext := "webp"
		if e.Animated {
			ext = "gif"
		}
		url := fmt.Sprintf("https://cdn.discordapp.com/emojis/%s.%s", e.ID, ext)
		base := sanitizeFilename(e.Name)
		if base == "" {
			base = e.ID
		}
		filename := base + "." + ext
		if _, ok := usedNames[filename]; ok {
			filename = fmt.Sprintf("%s_%s.%s", base, e.ID, ext)
		}
		usedNames[filename] = struct{}{}
		jobs = append(jobs, downloadJob{
			entry: e,
			path:  filepath.Join(guildID, filename),
			url:   url,
		})
	}

	fmt.Printf("Downloading %d emoji(s) into %s/ ...\n", len(jobs), guildID)

	var okCount, failCount atomic.Int32
	jobCh := make(chan downloadJob, len(jobs))
	var wg sync.WaitGroup

	for i := 0; i < workerCount; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for job := range jobCh {
				if err := downloadFile(client, job.url, job.path); err != nil {
					failCount.Add(1)
					fmt.Fprintf(os.Stderr, "FAIL %s: %v\n", job.entry.Name, err)
				} else {
					okCount.Add(1)
					fmt.Printf("OK   %s\n", job.entry.Name)
				}
			}
		}()
	}

	for _, j := range jobs {
		jobCh <- j
	}
	close(jobCh)
	wg.Wait()

	fmt.Printf("Done: %d ok, %d failed (total %d)\n", okCount.Load(), failCount.Load(), len(jobs))
	if failCount.Load() > 0 {
		os.Exit(1)
	}
}

func readLine(r *bufio.Reader, prompt string) string {
	fmt.Print(prompt)
	line, err := r.ReadString('\n')
	if err != nil && err != io.EOF {
		fatal("read input: %v", err)
	}
	return strings.TrimSpace(line)
}

func isSnowflake(s string) bool {
	if len(s) < 17 || len(s) > 20 {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func fetchGuildEmojis(client *http.Client, token, guildID string) ([]emojiEntry, error) {
	url := fmt.Sprintf("%s/guilds/%s/emojis", discordAPI, guildID)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", token)
	req.Header.Set("User-Agent", userAgent)

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("api request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("read api response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		snippet := strings.TrimSpace(string(body))
		if len(snippet) > maxErrBody {
			snippet = snippet[:maxErrBody] + "..."
		}
		return nil, fmt.Errorf("discord api %d %s: %s", resp.StatusCode, resp.Status, snippet)
	}

	var emojis []emojiEntry
	if err := json.Unmarshal(body, &emojis); err != nil {
		return nil, fmt.Errorf("parse emoji list: %w", err)
	}
	return emojis, nil
}

func downloadFile(client *http.Client, url, path string) error {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrBody))
		return fmt.Errorf("cdn %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}

	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	_, err = io.Copy(f, resp.Body)
	return err
}

func sanitizeFilename(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch r {
		case '\\', '/', ':', '*', '?', '"', '<', '>', '|':
			b.WriteRune('_')
		default:
			if unicode.IsControl(r) {
				continue
			}
			b.WriteRune(r)
		}
	}
	s := strings.TrimSpace(b.String())
	if s == "" {
		return s
	}
	upper := strings.ToUpper(s)
	reserved := []string{"CON", "PRN", "AUX", "NUL",
		"COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
		"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"}
	for _, r := range reserved {
		if upper == r {
			return s + "_"
		}
	}
	return s
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "Error: "+format+"\n", args...)
	os.Exit(1)
}
