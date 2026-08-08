package vn.englishhub.assessment.service;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;
import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.DataFormatter;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
public class QuizExcelService {
    private final DataFormatter formatter = new DataFormatter();

    public List<Map<String, Object>> parseQuestions(InputStream in) {
        try (Workbook workbook = new XSSFWorkbook(in)) {
            Sheet sheet = workbook.getNumberOfSheets() > 0 ? workbook.getSheetAt(0) : null;
            if (sheet == null) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Excel sheet is empty");
            }
            Row header = sheet.getRow(0);
            if (header == null) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Missing header row");
            }
            Map<String, Integer> cols = mapHeaders(header);
            requireCol(cols, "prompt");
            requireCol(cols, "answer");

            List<Map<String, Object>> questions = new ArrayList<>();
            for (int r = 1; r <= sheet.getLastRowNum(); r++) {
                Row row = sheet.getRow(r);
                if (row == null) {
                    continue;
                }
                String prompt = cell(row, cols.get("prompt"));
                String answer = cell(row, cols.get("answer"));
                if (prompt.isBlank() && answer.isBlank()) {
                    continue;
                }
                if (prompt.isBlank() || answer.isBlank()) {
                    throw new ResponseStatusException(
                            HttpStatus.BAD_REQUEST, "Row " + (r + 1) + " needs prompt and answer");
                }
                String type = cols.containsKey("type")
                        ? cell(row, cols.get("type")).toLowerCase(Locale.ROOT)
                        : "short";
                if (!type.equals("mcq") && !type.equals("short")) {
                    type = type.isBlank() ? "short" : type;
                    if (!type.equals("mcq") && !type.equals("short")) {
                        type = "short";
                    }
                }
                String choicesRaw = cols.containsKey("choices") ? cell(row, cols.get("choices")) : "";
                Map<String, Object> q = new LinkedHashMap<>();
                q.put("id", UUID.randomUUID().toString());
                q.put("prompt", prompt);
                q.put("type", type.equals("mcq") ? "mcq" : "short");
                q.put("answer", answer);
                if ("mcq".equals(q.get("type"))) {
                    List<String> choices = Arrays.stream(choicesRaw.split("[|;]"))
                            .map(String::trim)
                            .filter(s -> !s.isEmpty())
                            .collect(Collectors.toList());
                    if (choices.isEmpty()) {
                        throw new ResponseStatusException(
                                HttpStatus.BAD_REQUEST, "Row " + (r + 1) + " MCQ needs choices");
                    }
                    q.put("choices", choices);
                }
                questions.add(q);
            }
            if (questions.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "No questions found in Excel");
            }
            return questions;
        } catch (ResponseStatusException e) {
            throw e;
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid Excel file: " + e.getMessage());
        }
    }

    public byte[] exportQuestions(String title, List<Map<String, Object>> questions) {
        try (Workbook workbook = new XSSFWorkbook(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            Sheet sheet = workbook.createSheet(sanitizeSheetName(title));
            Row header = sheet.createRow(0);
            header.createCell(0).setCellValue("prompt");
            header.createCell(1).setCellValue("type");
            header.createCell(2).setCellValue("choices");
            header.createCell(3).setCellValue("answer");

            for (int i = 0; i < questions.size(); i++) {
                Map<String, Object> q = questions.get(i);
                Row row = sheet.createRow(i + 1);
                row.createCell(0).setCellValue(str(q.get("prompt")));
                String type = str(q.get("type"));
                if (!"mcq".equalsIgnoreCase(type)) {
                    type = "short";
                }
                row.createCell(1).setCellValue(type.toLowerCase(Locale.ROOT));
                Object choices = q.get("choices");
                String choicesCell = "";
                if (choices instanceof List<?> list) {
                    choicesCell = list.stream().map(String::valueOf).collect(Collectors.joining(" | "));
                } else if (choices != null) {
                    choicesCell = String.valueOf(choices);
                }
                row.createCell(2).setCellValue(choicesCell);
                row.createCell(3).setCellValue(str(q.get("answer")));
            }
            for (int c = 0; c < 4; c++) {
                sheet.autoSizeColumn(c);
            }
            workbook.write(out);
            return out.toByteArray();
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Failed to export Excel");
        }
    }

    private Map<String, Integer> mapHeaders(Row header) {
        Map<String, Integer> cols = new LinkedHashMap<>();
        for (Cell cell : header) {
            String name = formatter.formatCellValue(cell).trim().toLowerCase(Locale.ROOT);
            if (!name.isEmpty()) {
                cols.put(name, cell.getColumnIndex());
            }
        }
        return cols;
    }

    private void requireCol(Map<String, Integer> cols, String name) {
        if (!cols.containsKey(name)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Missing column: " + name);
        }
    }

    private String cell(Row row, Integer idx) {
        if (idx == null) {
            return "";
        }
        Cell cell = row.getCell(idx);
        return cell == null ? "" : formatter.formatCellValue(cell).trim();
    }

    private static String str(Object v) {
        return v == null ? "" : String.valueOf(v).trim();
    }

    private static String sanitizeSheetName(String title) {
        String base = (title == null || title.isBlank()) ? "Quiz" : title.trim();
        String cleaned = base.replaceAll("[\\\\/?*\\[\\]:]", "_");
        return cleaned.length() > 31 ? cleaned.substring(0, 31) : cleaned;
    }
}
