import com.google.zxing.BinaryBitmap;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.Result;
import com.google.zxing.RGBLuminanceSource;
import com.google.zxing.common.HybridBinarizer;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.File;

/**
 * Decodes a QR image back to text, to verify a generated pairing code.
 * Uses only zxing-core (RGBLuminanceSource) plus the JDK's ImageIO.
 */
public final class QrDecode {
    public static void main(String[] args) throws Exception {
        BufferedImage image = ImageIO.read(new File(args[0]));
        if (image == null) {
            System.err.println("not an image: " + args[0]);
            System.exit(2);
        }
        int w = image.getWidth();
        int h = image.getHeight();
        int[] pixels = new int[w * h];
        image.getRGB(0, 0, w, h, pixels, 0, w);
        BinaryBitmap bitmap = new BinaryBitmap(
                new HybridBinarizer(new RGBLuminanceSource(w, h, pixels)));
        Result result = new MultiFormatReader().decode(bitmap);
        System.out.println(result.getText());
    }
}
