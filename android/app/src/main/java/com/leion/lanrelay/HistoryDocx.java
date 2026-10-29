package com.leion.lanrelay;

import java.io.File;
import java.io.FileOutputStream;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * 把一条会议记录导出成 **.docx**（4.71）。
 *
 * <p>为什么手写：项目有一条硬规矩——**不引第三方库**（除了眼镜 SDK 与 Java-WebSocket）。
 * 而 docx 的本质就是"一个装了若干 XML 的 zip"，用 JDK 自带的 {@link ZipOutputStream}
 * 就能生成，没必要为了一个导出功能去背一个 Apache POI 进来（那会多出十几 MB）。
 *
 * <p>只写最小可用的三个部分（少了任何一个 Word 都打不开）：
 * <ul>
 *   <li>{@code [Content_Types].xml} —— 声明 docx 主文档的 MIME；</li>
 *   <li>{@code _rels/.rels} —— 指向主文档的关系；</li>
 *   <li>{@code word/document.xml} —— 正文。</li>
 * </ul>
 *
 * <p>导出内容严格等于"这条记录已有的历史内容"：概览（时间/时长/人数/语言）+ 转写全文。
 * **不生成摘要、不生成行动项**（会议纪要按建议砍掉了，导出也不假装有）。
 */
public final class HistoryDocx {

    private HistoryDocx() {
    }

    /**
     * @param target  目标文件（通常放在缓存目录）
     * @param title   文档标题（一般是会议名称）
     * @param lines   正文段落：每行一段，空行会变成一个空段落
     * @return 写好的文件
     */
    public static File write(File target, String title, List<String> lines) throws Exception {
        StringBuilder body = new StringBuilder();
        body.append(paragraph(title, true));
        for (String line : lines) {
            body.append(paragraph(line == null ? "" : line, false));
        }
        String document = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
                + "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">"
                + "<w:body>" + body
                // 页面尺寸用 A4（Word 缺省也行，但写死更稳）
                + "<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/></w:sectPr>"
                + "</w:body></w:document>";

        String contentTypes = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
                + "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">"
                + "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>"
                + "<Default Extension=\"xml\" ContentType=\"application/xml\"/>"
                + "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-"
                + "officedocument.wordprocessingml.document.main+xml\"/>"
                + "</Types>";

        String rels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
                + "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
                + "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/"
                + "relationships/officeDocument\" Target=\"word/document.xml\"/>"
                + "</Relationships>";

        File parent = target.getParentFile();
        if (parent != null && !parent.exists()) {
            //noinspection ResultOfMethodCallIgnored
            parent.mkdirs();
        }
        ZipOutputStream zip = new ZipOutputStream(new FileOutputStream(target));
        try {
            put(zip, "[Content_Types].xml", contentTypes);
            put(zip, "_rels/.rels", rels);
            put(zip, "word/document.xml", document);
        } finally {
            zip.close();
        }
        return target;
    }

    private static void put(ZipOutputStream zip, String name, String content) throws Exception {
        zip.putNextEntry(new ZipEntry(name));
        zip.write(content.getBytes("UTF-8"));
        zip.closeEntry();
    }

    /** 一段文字；bold 用于标题。XML 特殊字符必须转义，否则 Word 直接报文件损坏。 */
    private static String paragraph(String text, boolean bold) {
        StringBuilder run = new StringBuilder();
        run.append("<w:r>");
        if (bold) run.append("<w:rPr><w:b/></w:rPr>");
        run.append("<w:t xml:space=\"preserve\">").append(escape(text)).append("</w:t>");
        run.append("</w:r>");
        return "<w:p>" + run + "</w:p>";
    }

    private static String escape(String text) {
        return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace("\"", "&quot;");
    }
}
